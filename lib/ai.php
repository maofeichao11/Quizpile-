<?php
/**
 * AI 导题库：把 Word / Excel / PPT / 文本等杂格式题库交给大模型解析成标准题目。
 *
 * 流程：上传文件 -> ai_extract_text() 抽出纯文本 -> 分块 -> ai_parse_chunk() 调模型
 *      -> ai_normalize_item() 归一化 -> 前端展示预览（含重复比对）-> import_commit 入库
 */

const AI_CHUNK_CHARS = 2400;    // 每次送给模型的字数（模型是推理模型，块小一点单次更快、更不易超时）
const AI_MAX_CHARS   = 600000;  // 单文件最多解析的字数
const AI_TIMEOUT     = 150;     // 单次调用超时（秒）

/** 读取当前用户的 AI 配置；**不提供任何默认值**，没填就是空 */
function ai_user_config()
{
    $s = user_settings();
    return array(
        'base'  => isset($s['ai_base'])  ? trim((string) $s['ai_base'])  : '',
        'model' => isset($s['ai_model']) ? trim((string) $s['ai_model']) : '',
        'key'   => isset($s['ai_key'])   ? trim((string) $s['ai_key'])   : '',
    );
}

/** 配置是否齐全；不齐时返回缺哪几项 */
function ai_config_check($cfg)
{
    $missing = array();
    if ($cfg['base'] === '')  $missing[] = '接口地址';
    if ($cfg['model'] === '') $missing[] = '模型名';
    if ($cfg['key'] === '')   $missing[] = 'API Key';
    return array(
        'ready'   => !$missing,
        'missing' => $missing,
        'msg'     => $missing ? ('请先到「设置 → AI 导题库配置」填写：' . implode('、', $missing)) : '',
    );
}

/* ---------------- 文件文本提取 ---------------- */

/** 统一转成 UTF-8（兼容 GBK/GB18030 的 txt/csv） */
function ai_to_utf8($s)
{
    if ($s === '' || $s === null) return '';
    if (substr($s, 0, 3) === "\xEF\xBB\xBF") $s = substr($s, 3);
    if (function_exists('mb_check_encoding') && mb_check_encoding($s, 'UTF-8')) return $s;
    $enc = function_exists('mb_detect_encoding')
        ? mb_detect_encoding($s, array('UTF-8', 'GB18030', 'GBK', 'BIG-5', 'Windows-1252'), true)
        : false;
    if ($enc && $enc !== 'UTF-8') {
        $s = @mb_convert_encoding($s, 'UTF-8', $enc);
    } else {
        $s = @mb_convert_encoding($s, 'UTF-8', 'GB18030');
    }
    return $s === false ? '' : $s;
}

/** 打开 zip 一次，返回符合条件的条目内容 */
function ai_zip_entries($path, $regex, $sort = true)
{
    $out = array();
    if (!class_exists('ZipArchive')) return $out;
    $z = new ZipArchive();
    if ($z->open($path) !== true) return $out;
    for ($i = 0; $i < $z->numFiles; $i++) {
        $name = $z->getNameIndex($i);
        if (preg_match($regex, $name)) {
            $out[$name] = $z->getFromIndex($i);
        }
    }
    $z->close();
    if ($sort) uksort($out, function ($a, $b) {
        return strnatcasecmp($a, $b);
    });
    return $out;
}

/** 从 Word（.docx）抽取文本 */
function ai_extract_docx($path)
{
    $parts = ai_zip_entries($path, '#^word/(document|header\d*|footer\d*)\.xml$#i');
    if (!$parts) return '';
    $texts = array();
    foreach ($parts as $xml) {
        // 段落、换行、制表符 → 对应文本符号
        $xml = preg_replace('#<w:tab\s*/?>#i', "\t", $xml);
        $xml = preg_replace('#<w:br\s*/?>#i', "\n", $xml);
        $xml = preg_replace('#</w:p>#i', "\n", $xml);
        $xml = preg_replace('#</w:tr>#i', "\n", $xml);
        $xml = preg_replace('#</w:tc>#i', "\t", $xml);
        $t = strip_tags($xml);
        $t = html_entity_decode($t, ENT_QUOTES, 'UTF-8');
        $texts[] = $t;
    }
    return implode("\n", $texts);
}

/** 从 PowerPoint（.pptx）抽取文本，每页之间空行分隔 */
function ai_extract_pptx($path)
{
    $slides = ai_zip_entries($path, '#^ppt/slides/slide\d+\.xml$#i');
    $out = array();
    foreach ($slides as $xml) {
        if (!preg_match_all('#<a:t>(.*?)</a:t>#is', $xml, $m)) continue;
        $lines = array();
        foreach ($m[1] as $t) {
            $t = html_entity_decode($t, ENT_QUOTES, 'UTF-8');
            if (trim($t) !== '') $lines[] = $t;
        }
        if ($lines) $out[] = implode("\n", $lines);
    }
    return implode("\n\n", $out);
}

/** 从 Excel（.xlsx）抽取文本：共享字符串 + 各工作表按行列还原 */
function ai_extract_xlsx($path)
{
    $shared = array();
    $ss = ai_zip_entries($path, '#^xl/sharedStrings\.xml$#i', false);
    if ($ss) {
        $xml = reset($ss);
        if (preg_match_all('#<si>(.*?)</si>#is', $xml, $m)) {
            foreach ($m[1] as $si) {
                if (preg_match_all('#<t[^>]*>(.*?)</t>#is', $si, $mm)) {
                    $s = '';
                    foreach ($mm[1] as $piece) $s .= html_entity_decode($piece, ENT_QUOTES, 'UTF-8');
                    $shared[] = $s;
                } else {
                    $shared[] = '';
                }
            }
        }
    }
    $sheets = ai_zip_entries($path, '#^xl/worksheets/sheet\d+\.xml$#i');
    $out = array();
    foreach ($sheets as $xml) {
        if (!preg_match_all('#<row[^>]*>(.*?)</row>#is', $xml, $rows)) continue;
        foreach ($rows[1] as $rowXml) {
            $cells = array();
            if (preg_match_all('#<c([^>]*)>(.*?)</c>#is', $rowXml, $cs, PREG_SET_ORDER)) {
                foreach ($cs as $c) {
                    $attr = $c[1];
                    $inner = $c[2];
                    $val = '';
                    if (preg_match('#<v[^>]*>(.*?)</v>#is', $inner, $vm)) {
                        $val = html_entity_decode($vm[1], ENT_QUOTES, 'UTF-8');
                        if (strpos($attr, 't="s"') !== false || strpos($attr, "t='s'") !== false) {
                            $idx = (int) $val;
                            $val = isset($shared[$idx]) ? $shared[$idx] : '';
                        }
                    } elseif (preg_match('#<is>.*?<t[^>]*>(.*?)</t>.*?</is>#is', $inner, $im)) {
                        $val = html_entity_decode($im[1], ENT_QUOTES, 'UTF-8');
                    }
                    $cells[] = trim($val);
                }
            }
            $line = trim(implode("\t", $cells));
            if ($line !== '') $out[] = $line;
        }
        $out[] = '';
    }
    return implode("\n", $out);
}

/**
 * 从上传文件提取纯文本。
 * 支持 docx / xlsx / pptx / txt / csv / tsv / md / json / html
 * 不支持旧版二进制格式（doc/xls/ppt）与 pdf，会抛出可读的错误提示。
 */
function ai_extract_text($path, $ext)
{
    $ext = strtolower($ext);
    switch ($ext) {
        case 'docx':
            $t = ai_extract_docx($path);
            break;
        case 'pptx':
            $t = ai_extract_pptx($path);
            break;
        case 'xlsx':
            $t = ai_extract_xlsx($path);
            break;
        case 'txt':
        case 'csv':
        case 'tsv':
        case 'md':
        case 'markdown':
        case 'json':
        case 'html':
        case 'htm':
            $t = ai_to_utf8(file_get_contents($path));
            if ($ext === 'html' || $ext === 'htm') {
                $t = strip_tags(preg_replace('#<(br|/p|/div|/tr|/li)[^>]*>#i', "\n", $t));
            }
            break;
        case 'doc':
        case 'xls':
        case 'ppt':
            throw new Exception('暂不支持旧版 .' . $ext . ' 格式，请在 Office/WPS 里另存为 .docx / .xlsx / .pptx 后重试');
        case 'pdf':
            throw new Exception('暂不支持 PDF（无法可靠取文本），请转成 Word / 文本后重试，或直接把文字粘贴到下方输入框');
        default:
            throw new Exception('不支持的文件类型：.' . $ext);
    }
    $t = str_replace(array("\r\n", "\r"), "\n", (string) $t);
    // 压缩连续空行，减少无意义字符
    $t = preg_replace("/\n{3,}/", "\n\n", $t);
    $t = trim($t);
    if ($t === '') throw new Exception('没有从文件里读到任何文字，请确认文件内容是否为空或为扫描图片');
    return $t;
}

/** 按行边界切块，保证每块不超过 $size 字 */
function ai_split_chunks($text, $size = AI_CHUNK_CHARS)
{
    $lines  = explode("\n", $text);
    $chunks = array();
    $cur    = '';
    foreach ($lines as $ln) {
        if ($cur !== '' && mb_strlen($cur, 'UTF-8') + mb_strlen($ln, 'UTF-8') + 1 > $size) {
            $chunks[] = $cur;
            $cur = '';
        }
        $cur .= ($cur === '' ? '' : "\n") . $ln;
        while (mb_strlen($cur, 'UTF-8') > $size) {
            $chunks[] = mb_substr($cur, 0, $size, 'UTF-8');
            $cur = mb_substr($cur, $size, null, 'UTF-8');
        }
    }
    if (trim($cur) !== '') $chunks[] = $cur;
    return $chunks ? $chunks : array('');
}

/* ---------------- 调用大模型 ---------------- */

/** OpenAI 兼容的 chat/completions 调用，返回 content 文本 */
function ai_chat($base, $key, $model, $messages, $timeout = AI_TIMEOUT)
{
    if (!function_exists('curl_init')) throw new Exception('服务器未开启 curl 扩展');
    $url = rtrim($base, '/');
    if (substr($url, -17) !== '/chat/completions') {
        // 允许用户只填到 /v3 或填完整地址
        if (substr($url, -3) === '/v1' || substr($url, -3) === '/v3') $url .= '/chat/completions';
        elseif (strpos($url, '/chat/completions') === false) $url .= '/chat/completions';
    }
    $payload = array(
        'model'       => $model,
        'messages'    => $messages,
        'temperature' => 0.2,
        'stream'      => false,
    );
    $ch = curl_init($url);
    curl_setopt_array($ch, array(
        CURLOPT_POST           => true,
        CURLOPT_POSTFIELDS     => json_encode($payload, JSON_UNESCAPED_UNICODE),
        CURLOPT_HTTPHEADER     => array('Content-Type: application/json', 'Authorization: Bearer ' . $key),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => $timeout,
        CURLOPT_CONNECTTIMEOUT => 20,
        CURLOPT_SSL_VERIFYPEER => false,
    ));
    $res  = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    if ($res === false)        throw new Exception('连接 AI 接口失败：' . ($err ?: '网络错误'));
    $j = json_decode($res, true);
    if ($code < 200 || $code >= 300) {
        $msg = '';
        if (isset($j['error']['message'])) $msg = $j['error']['message'];
        elseif (isset($j['message']))       $msg = $j['message'];
        else                                $msg = mb_substr((string) $res, 0, 300, 'UTF-8');
        throw new Exception('AI 接口返回 ' . $code . '：' . $msg);
    }
    if (!isset($j['choices'][0]['message']['content'])) {
        throw new Exception('AI 未返回内容（可能是模型名或接口地址不正确）');
    }
    return (string) $j['choices'][0]['message']['content'];
}

/** 测试连接：发一句最短的请求，验证地址/密钥/模型是否可用 */
function ai_test_connection($base, $key, $model)
{
    $r = ai_chat($base, $key, $model, array(
        array('role' => 'user', 'content' => '回复 ok 两个字符即可'),
    ), 60);
    return trim($r) !== '';
}

/* ---------------- 解析提示词与结果归一化 ---------------- */

function ai_messages($text)
{
    $sys = "你是题库结构化助手。用户会给你一段从 Word/Excel/PPT/文本中提取出来的题库内容，"
        . "格式可能不统一。请把它转换成严格的 JSON 数组，不要输出任何解释、Markdown 代码块或多余文字。\n\n"
        . "每个题目对象的字段：\n"
        . "- type：必须是 single / multiple / judge / blank / essay 之一（单选=single，多选=multiple，判断=judge，填空=blank，简答=essay）\n"
        . "- stem：题干原文，不含题号、题型标记、选项、答案；需要换行用 \\n\n"
        . "- options：选项数组，每项 {\"key\":\"A\",\"text\":\"内容\"}；判断题固定为 [{\"key\":\"A\",\"text\":\"正确\"},{\"key\":\"B\",\"text\":\"错误\"}]；填空/简答为 []\n"
        . "- answer：答案数组。选择题填字母（多选如 [\"A\",\"C\"]）；判断题正确 [\"A\"]、错误 [\"B\"]；填空/简答填答案文本\n"
        . "- analysis：解析文本，没有就空字符串\n"
        . "- chapter：章节或分类，没有就空字符串\n"
        . "- tags：标签，没有就空字符串\n"
        . "- uncertain：布尔值。原文里找不到答案时填 true，并把 answer 设为 []\n\n"
        . "规则：\n"
        . "1. 忠于原文，不要编造题干或答案；答案无法确定时 answer 设 []、uncertain 设 true。\n"
        . "2. 题号（如 \"1.\"、\"(1)\"、\"第1题\"）不要放进 stem。\n"
        . "3. 公式、代码保持原样文本。\n"
        . "4. 若同一题同时出现题干、选项、答案（答案可能标为\"答案：\"、\"参考答案\"、\"正确答案\"或加粗/括号），请正确对应。\n"
        . "5. 只输出 JSON 数组本身，从 [ 开始到 ] 结束。";

    return array(
        array('role' => 'system', 'content' => $sys),
        array('role' => 'user', 'content' => "请解析以下题库内容：\n\n" . $text),
    );
}

/** 从模型输出里抠出 JSON 数组 */
function ai_decode_json($content)
{
    $s = trim((string) $content);
    // 去掉 ```json ... ``` 包裹
    $s = preg_replace('#^```[a-zA-Z]*\s*#', '', $s);
    $s = preg_replace('#\s*```$#', '', $s);
    $arr = json_decode($s, true);
    if (is_array($arr)) return $arr;
    // 兜底：截取第一个 [ 到最后一个 ]
    $a = strpos($s, '[');
    $b = strrpos($s, ']');
    if ($a !== false && $b !== false && $b > $a) {
        $arr = json_decode(substr($s, $a, $b - $a + 1), true);
        if (is_array($arr)) return $arr;
    }
    return array();
}

/** 把答案项（可能是文字/符号）转成选项字母 */
function ai_answer_to_key($v, $options)
{
    $s = trim((string) $v);
    if ($s === '') return '';
    // 已是字母
    if (preg_match('/^[A-Za-z]$/', $s)) return strtoupper($s);
    // 正确/错误类
    $t = strtolower($s);
    if (in_array($t, array('正确', '对', '是', '√', 'true', 't', 'yes', 'y'), true)) return 'A';
    if (in_array($t, array('错误', '错', '否', '×', 'x', 'false', 'f', 'no', 'n'), true)) return 'B';
    // 用选项文本反查
    foreach ($options as $o) {
        if ($o['text'] !== '' && $o['text'] === $s) return $o['key'];
    }
    return '';
}

/** 归一化单个题目；无法使用时返回 null */
function ai_normalize_item($it)
{
    if (!is_array($it)) return null;
    $stem = isset($it['stem']) ? trim((string) $it['stem']) : '';
    if ($stem === '') return null;

    $type = normalize_type(isset($it['type']) ? $it['type'] : '');
    if ($type === null) $type = normalize_type(isset($it['type_name']) ? $it['type_name'] : '');

    // 选项
    $options = array();
    $rawOpts = isset($it['options']) ? $it['options'] : array();
    if (is_array($rawOpts)) {
        foreach ($rawOpts as $i => $o) {
            if (is_array($o)) {
                $text = isset($o['text']) ? trim((string) $o['text']) : '';
                $key  = isset($o['key']) && $o['key'] !== '' ? strtoupper((string) $o['key']) : chr(65 + $i);
            } else {
                $text = trim((string) $o);
                $key  = chr(65 + $i);
            }
            if ($text === '') continue;
            $options[] = array('key' => $key, 'text' => $text);
        }
    }

    // 判断题：识别是否写成了「对/错」两个选项（judge_word_kind 返回 right/wrong/null）
    $isJudgeByOptions = false;
    if (count($options) === 2) {
        $k0 = judge_word_kind($options[0]['text']);
        $k1 = judge_word_kind($options[1]['text']);
        if ($k0 && $k1 && $k0 !== $k1) $isJudgeByOptions = true;
    }

    // 答案
    $answer = isset($it['answer']) ? $it['answer'] : array();
    if (!is_array($answer)) $answer = array($answer);
    $ansKeys = array();
    foreach ($answer as $a) {
        $a = is_array($a) ? implode('', $a) : trim((string) $a);
        if ($a === '') continue;
        if ($type === 'blank' || $type === 'essay') {
            $ansKeys[] = $a;
            continue;
        }
        // 可能一次给了 "AC"
        if ($options) {
            if (preg_match('/^[A-Za-z]{1,6}$/', $a)) {
                foreach (str_split(strtoupper($a)) as $ch) $ansKeys[] = $ch;
            } else {
                $k = ai_answer_to_key($a, $options);
                if ($k !== '') $ansKeys[] = $k; else $ansKeys[] = $a;
            }
        } else {
            $ansKeys[] = $a;
        }
    }
    $ansKeys = array_values(array_unique(array_filter($ansKeys, function ($x) { return $x !== ''; })));

    // 判断类型
    if ($type === null) {
        if ($isJudgeByOptions) {
            $type = 'judge';
        } elseif ($options) {
            $type = count($ansKeys) > 1 ? 'multiple' : 'single';
        } elseif ($ansKeys) {
            $type = 'blank';
        } else {
            $type = 'single';
        }
    }
    if ($type === 'judge' || $isJudgeByOptions) {
        $type = 'judge';
        $options = array(
            array('key' => 'A', 'text' => '正确'),
            array('key' => 'B', 'text' => '错误'),
        );
        // 判断题答案统一成 A/B
        $fixed = array();
        foreach ($ansKeys as $k) {
            $u = strtoupper((string) $k);
            if ($u === 'A' || $u === 'B') { $fixed[] = $u; continue; }
            $m = ai_answer_to_key($k, array());
            if ($m !== '') $fixed[] = $m;
        }
        $ansKeys = array_values(array_unique($fixed));
    }
    // 选择题答案只保留有效选项字母
    if ($type === 'single' || $type === 'multiple') {
        $valid = array();
        foreach ($options as $o) $valid[] = $o['key'];
        $ansKeys = array_values(array_filter($ansKeys, function ($k) use ($valid) {
            return in_array(strtoupper((string) $k), $valid, true);
        }));
        $ansKeys = array_map('strtoupper', $ansKeys);
        if ($type === 'single' && count($ansKeys) > 1) $ansKeys = array_slice($ansKeys, 0, 1);
        if ($type === 'multiple' && count($ansKeys) < 2) $type = 'single';
    }

    return array(
        'type'      => $type,
        'stem'      => $stem,
        'options'   => $options,
        'answer'    => $ansKeys,
        'analysis'  => isset($it['analysis']) ? trim((string) $it['analysis']) : '',
        'chapter'   => isset($it['chapter']) ? trim((string) $it['chapter']) : '',
        'tags'      => isset($it['tags']) ? trim((string) $it['tags']) : '',
        'uncertain' => !empty($it['uncertain']) || !$ansKeys,
    );
}

/** 归一化一批 */
function ai_normalize_items($raw)
{
    $out = array();
    foreach ($raw as $it) {
        $n = ai_normalize_item($it);
        if ($n) $out[] = $n;
    }
    return $out;
}

/* ---------------- 本地精确解析（结构化内容优先，省时省钱） ---------------- */

/**
 * 如果内容本身已是结构化题库（JSON / CSV），先用本地规则精确解析，
 * 成功则完全不消耗 AI（也避免大文件调用模型超时）。
 * 返回 array('kind' => 'json|yutian|csv', 'items' => [...])，识别不了返回 null。
 */
function ai_try_local_parse($text, $ext = '')
{
    $t = trim((string) $text);
    if ($t === '') return null;
    $ext = strtolower($ext);
    $looksJson = ($t[0] === '[' || $t[0] === '{');

    // 誉天格式（有 optionA / 特定 type 特征）
    if ($looksJson) {
        $arr = json_decode(preg_replace('/^\xEF\xBB\xBF/', '', $t), true);
        if (is_array($arr)) {
            $first = isset($arr[0]) ? $arr[0] : (isset($arr['data'][0]) ? $arr['data'][0] : null);
            $isYutian = is_array($first) && (
                array_key_exists('optionA', $first)
                || (array_key_exists('title', $first) && array_key_exists('answer', $first) && array_key_exists('type', $first))
            );
            $items = $isYutian ? parse_questions_yutian($t) : parse_questions_json($t);
            if ($items) {
                $norm = ai_normalize_items($items);
                if ($norm) {
                    return array('kind' => $isYutian ? 'yutian' : 'json', 'items' => $norm);
                }
            }
        }
    }
    // CSV：仅当扩展名是 csv/tsv，或首行明显是带表头的 CSV（避免把普通文本误判成 CSV）
    $firstLine = strtok($t, "\r\n");
    $looksCsvHeader = $firstLine !== false
        && (strpos($firstLine, ',') !== false || strpos($firstLine, "\t") !== false)
        && (stripos($firstLine, '题干') !== false || stripos($firstLine, 'stem') !== false
            || stripos($firstLine, '题型') !== false || stripos($firstLine, 'type') !== false);
    if ($ext === 'csv' || $ext === 'tsv' || $looksCsvHeader) {
        $items = parse_questions_csv($t);
        if ($items) {
            $norm = ai_normalize_items($items);
            if ($norm) return array('kind' => 'csv', 'items' => $norm);
        }
    }
    return null;
}

/* ---------------- 重复比对 ---------------- */

/** 用于比对题干是否相同的归一化：去掉空白、标点、大小写差异 */
function ai_fingerprint($s)
{
    $s = mb_strtolower((string) $s, 'UTF-8');
    $s = preg_replace('/[\s\x{3000}]+/u', '', $s);
    $s = preg_replace('/[，。、；：？！,.;:?!"\'“”‘’（）()\[\]【】<>《》\-—_]+/u', '', $s);
    return $s;
}

/**
 * 把待导入题目与题库已有题目比对。
 * 返回 array(index => array('dup_id'=>..,'dup_stem'=>..,'reason'=>'exact'|'similar'))
 */
function ai_find_duplicates($bankId, $items)
{
    $rows = q('SELECT id, stem FROM `questions` WHERE bank_id=? AND deleted_at IS NULL', array($bankId));
    $map = array();
    $prefixes = array(0 => array());
    foreach ($rows as $r) {
        $fp = ai_fingerprint($r['stem']);
        if ($fp === '') continue;
        if (!isset($map[$fp])) $map[$fp] = $r;
        $p = mb_substr($fp, 0, 24, 'UTF-8');
        if (mb_strlen($p, 'UTF-8') >= 12) $prefixes[0][$p][] = $r;
    }
    $result = array();
    foreach ($items as $i => $it) {
        $fp = ai_fingerprint(isset($it['stem']) ? $it['stem'] : '');
        if ($fp === '') continue;
        if (isset($map[$fp])) {
            $result[$i] = array('dup_id' => (int) $map[$fp]['id'], 'dup_stem' => $map[$fp]['stem'], 'reason' => 'exact');
            continue;
        }
        // 近似：题干前 24 字相同的前缀
        $p = mb_substr($fp, 0, 24, 'UTF-8');
        if (mb_strlen($p, 'UTF-8') >= 12 && !empty($prefixes[0][$p])) {
            $first = $prefixes[0][$p][0];
            $result[$i] = array('dup_id' => (int) $first['id'], 'dup_stem' => $first['stem'], 'reason' => 'similar');
        }
    }
    return $result;
}

/* ---------------- 临时文本存取 ---------------- */

function ai_tmp_dir()
{
    $dir = dirname(__DIR__) . '/uploads/ai';
    if (!is_dir($dir)) @mkdir($dir, 0777, true);
    return $dir;
}

function ai_tmp_path($token)
{
    return ai_tmp_dir() . '/' . preg_replace('/[^a-zA-Z0-9_]/', '', $token) . '.txt';
}

/** 保存提取出的文本，返回 token */
function ai_store_text($text)
{
    $token = bin2hex(random_bytes(8));
    file_put_contents(ai_tmp_path($token), $text);
    // 顺手清理 1 天前的临时文件
    foreach (glob(ai_tmp_dir() . '/*.txt') as $f) {
        if (filemtime($f) < time() - 86400) @unlink($f);
    }
    return $token;
}

function ai_load_text($token)
{
    $p = ai_tmp_path($token);
    if (!is_file($p)) throw new Exception('解析会话已过期，请重新上传文件');
    return file_get_contents($p);
}
