<?php
/**
 * 题目相关：类型定义、判分、文本/CSV/JSON 解析导入。
 * 注意：运行环境为 PHP 7.3，不使用 match / str_contains / 箭头函数。
 */

function type_names()
{
    return [
        'single'   => '单选题',
        'multiple' => '多选题',
        'judge'    => '判断题',
        'blank'    => '填空题',
        'essay'    => '简答题',
    ];
}

function type_name($type)
{
    $names = type_names();
    return isset($names[$type]) ? $names[$type] : '未知题型';
}

/** 客观题（可自动判分） */
function is_objective($type)
{
    return in_array($type, array('single', 'multiple', 'judge', 'blank'), true);
}

function decode_json_field($value, $default = array())
{
    $v = json_decode((string) $value, true);
    return is_array($v) ? $v : $default;
}

/** 文本归一化：去空白、部分全角转半角、小写，用于填空/简答比对 */
function norm_text($s)
{
    $s = trim((string) $s);
    $s = str_replace(array('　', ' '), '', $s);
    $s = str_replace(array('，', '。', '；', '：', '、', '（', '）'), array(',', '.', ';', ':', ',', '(', ')'), $s);
    return strtolower($s);
}

/**
 * 判分。返回 array('correct' => bool|null, 'expected' => string)
 * $user: 数组（客观题选项 key）或字符串（填空/简答）
 */
function grade_answer($question, $user)
{
    $type   = $question['type'];
    $answer = decode_json_field($question['answer']);

    if ($type === 'single' || $type === 'multiple' || $type === 'judge') {
        $u = is_array($user) ? $user : array($user);
        $u = array_values(array_unique(array_filter(array_map('strtoupper', array_map('strval', $u)), 'strlen')));
        $a = array_values(array_unique(array_map('strtoupper', array_map('strval', $answer))));
        sort($u);
        sort($a);
        return array(
            'correct'  => $u === $a,
            'expected' => implode('', $a),
        );
    }

    if ($type === 'blank') {
        $u = norm_text(is_array($user) ? implode('|', $user) : (string) $user);
        foreach ($answer as $accept) {
            if ($u === norm_text($accept)) {
                return array('correct' => true, 'expected' => implode(' / ', $answer));
            }
        }
        return array('correct' => false, 'expected' => implode(' / ', $answer));
    }

    // 简答题：不自判，交给用户自评
    return array('correct' => null, 'expected' => implode(' / ', $answer));
}

/**
 * 纯文本解析导入。支持格式示例：
 *
 * 【单选】1+1=?
 * A. 1
 * B. 2
 * C. 3
 * D. 4
 * 答案：B
 * 解析：基础算术
 *
 * 判断题题干
 * 答案：对
 *
 * 中国的首都是____。
 * 答案：北京
 */
function parse_questions_text($text)
{
    $text  = str_replace(array("\r\n", "\r"), "\n", $text);
    $lines = explode("\n", $text);

    $blocks   = array();
    $cur      = null;
    // 答案行出现后，再遇到非「解析/标签」的内容行，说明下一题开始了
    $ansRe    = '/^(?:答案|正确答案|【答案】)\s*[：:]?/u';
    $tailRe   = '/^(?:解析|【解析】|标签|【标签】)\s*[：:]?/u';

    foreach ($lines as $line) {
        $line = rtrim($line);
        if (trim($line) === '') {
            continue;
        }
        $t = trim($line);
        $isAnswer   = (bool) preg_match($ansRe, $t);
        $isTail     = (bool) preg_match($tailRe, $t);

        if ($cur !== null && !empty($cur['has_answer']) && !$isTail && !$isAnswer) {
            $blocks[] = $cur;
            $cur = null;
        }
        if ($cur === null) {
            $cur = array('lines' => array(), 'has_answer' => false);
        }
        $cur['lines'][] = $line;
        if ($isAnswer) {
            $cur['has_answer'] = true;
        }
    }
    if ($cur !== null && !empty($cur['lines'])) {
        $blocks[] = $cur;
    }

    $result = array();
    foreach ($blocks as $block) {
        $item = parse_single_block($block['lines']);
        if ($item !== null) {
            $result[] = $item;
        }
    }
    return $result;
}

function parse_single_block($lines)
{
    $stem     = '';
    $options  = array();
    $answers  = array();
    $analysis = '';
    $tags     = '';
    $type     = null;
    $rawAnswer = null;

    $typeRe = '/^【\s*(单选|多选|判断|填空|简答|多选题|判断题|填空题|简答题)\s*】/u';

    foreach ($lines as $line) {
        $line = trim($line);
        if ($line === '') {
            continue;
        }

        // 题型标记
        if ($type === null && preg_match($typeRe, $line, $m)) {
            $type = normalize_type($m[1]);
            $line = trim(preg_replace($typeRe, '', $line));
            if ($line === '') {
                continue;
            }
        }

        // 题干开头的序号
        $line = preg_replace('/^\d+\s*[\.、\)．]\s*/u', '', $line);

        // 选项：A. xxx / A、xxx / (A) xxx
        if (preg_match('/^([A-Ha-h])\s*[\.、\)．：:]\s*(.+)$/u', $line, $m)) {
            $options[] = array('key' => strtoupper($m[1]), 'text' => trim($m[2]));
            continue;
        }
        if (preg_match('/^[（(]\s*([A-Ha-h])\s*[）)]\s*(.*)$/u', $line, $m)) {
            $options[] = array('key' => strtoupper($m[1]), 'text' => trim($m[2]));
            continue;
        }

        // 答案
        if (preg_match('/^(?:答案|正确答案|【答案】)\s*[：:]?\s*(.+)$/u', $line, $m)) {
            $rawAnswer = trim($m[1]);
            $answers = parse_answer_str($rawAnswer, $type, $options);
            continue;
        }

        // 解析
        if (preg_match('/^(?:解析|【解析】)\s*[：:]?\s*(.*)$/u', $line, $m)) {
            $analysis = trim($m[1]);
            continue;
        }

        // 标签
        if (preg_match('/^(?:标签|【标签】)\s*[：:]?\s*(.*)$/u', $line, $m)) {
            $tags = trim($m[1]);
            continue;
        }

        $stem .= ($stem === '' ? '' : "\n") . $line;
    }

    $stem = trim($stem);
    if ($stem === '') {
        return null;
    }

    // 题型推断
    if ($type === null) {
        if (count($options) > 0) {
            $type = (count($answers) > 1) ? 'multiple' : 'single';
        } elseif ($rawAnswer !== null && preg_match('/^(对|错|正确|错误|√|×|T|F|true|false)$/iu', $rawAnswer)) {
            $type    = 'judge';
            $first   = strtolower($rawAnswer);
            $answers = in_array($first, array('错', '错误', '×', 'x', 'f', 'false'), true) ? array('B') : array('A');
        } else {
            $type = 'blank';
        }
    }

    if ($type === 'judge') {
        $options = array(
            array('key' => 'A', 'text' => '正确'),
            array('key' => 'B', 'text' => '错误'),
        );
    }

    if (empty($answers)) {
        return null;
    }

    return array(
        'type'     => $type,
        'stem'     => $stem,
        'options'  => $options,
        'answer'   => $answers,
        'analysis' => $analysis,
        'tags'     => $tags,
    );
}

function parse_answer_str($raw, $type, $options)
{
    $raw = trim((string) $raw);
    if ($raw === '') {
        return array();
    }

    // 判断题
    if ($type === 'judge' || preg_match('/^(对|错|正确|错误|√|×|T|F)$/iu', $raw)) {
        $v = strtolower($raw);
        if (in_array($v, array('错', '错误', '×', 'x', 'f', 'false'), true)) {
            return array('B');
        }
        return array('A');
    }

    // 选项型答案：ABC / A,B / A;B
    if (preg_match('/^[A-Ha-h]+$/u', $raw)) {
        return str_split(strtoupper($raw));
    }
    if (preg_match('/^[A-Ha-h](?:\s*[，,、;；]\s*[A-Ha-h])+$/u', $raw)) {
        return array_map('strtoupper', preg_split('/\s*[，,、;；]\s*/u', strtoupper($raw)));
    }

    // 填空/简答：多个空用 | 分隔（不用逗号，避免把含逗号的答案拆开）
    $parts = preg_split('/\s*\|+\s*/u', $raw);
    $parts = array_values(array_filter(array_map('trim', $parts), function ($x) { return $x !== ''; }));
    return $parts ? $parts : array($raw);
}

/** CSV 导入：type,stem,A,B,C,D,answer,analysis,tags */
/**
 * 自己实现的 CSV 行解析（不依赖 str_getcsv / fgetcsv）。
 * 原因：PHP 7.3 的 str_getcsv 处理 UTF-8 中文有 bug —— 含中文的字段会把后面的逗号吞进字段里，
 * 例如 "甲,乙,丙" 会被解析成 1 个字段。这里按字节比较（只认 ASCII 的 , 和 "），对多字节安全。
 */
function csv_parse_line($line)
{
    $fields = array();
    $cur    = '';
    $inQ    = false;
    $len    = strlen($line);
    for ($i = 0; $i < $len; $i++) {
        $c = $line[$i];
        if ($inQ) {
            if ($c === '"') {
                if ($i + 1 < $len && $line[$i + 1] === '"') {
                    $cur .= '"';   // 转义的双引号
                    $i++;
                } else {
                    $inQ = false;
                }
            } else {
                $cur .= $c;
            }
        } elseif ($c === '"') {
            $inQ = true;
        } elseif ($c === ',') {
            $fields[] = $cur;
            $cur = '';
        } else {
            $cur .= $c;
        }
    }
    $fields[] = $cur;
    return $fields;
}

function parse_questions_csv($content)
{
    // 去掉 BOM：Excel 导出的 CSV 常带 BOM，不处理会让第一列表头变成 "\xEF\xBB\xBFtype"
    $content = preg_replace('/^\xEF\xBB\xBF/', '', $content);
    $content = str_replace(array("\r\n", "\r"), "\n", $content);
    $lines   = array_values(array_filter(explode("\n", $content), function ($l) { return trim($l) !== ''; }));
    if (!$lines) {
        return array();
    }

    $rows = array();
    foreach ($lines as $line) {
        $rows[] = csv_parse_line($line);
    }
    $header = array();
    foreach ($rows[0] as $h) {
        $header[] = strtolower(trim((string) $h));
    }
    /*
     * 表头列名（中英文都认，顺序随意）：
     *   推荐 6 列：题型,题干,选项,答案,解析,标签
     *   兼容旧 9 列：type,stem,A,B,C,D,answer,analysis,tags
     */
    $aliases = array(
        'type'     => array('type', '题型', '题目类型'),
        'stem'     => array('stem', '题干', '题目', '题面'),
        'options'  => array('options', 'option', '选项', '选项内容', '选项列表'),
        'answer'   => array('answer', '答案', '正确答案'),
        'analysis' => array('analysis', '解析', '解释'),
        'tags'     => array('tags', 'tag', '标签', '知识点'),
        'chapter'  => array('chapter', '章节'),
    );

    $isHeader = false;
    foreach ($aliases as $names) {
        foreach ($names as $n) {
            if (in_array(strtolower($n), $header, true)) {
                $isHeader = true;
                break 2;
            }
        }
    }

    // 单字母列（旧格式的 A/B/C/D）
    $letterCols = array();
    foreach ($header as $i => $h) {
        if (preg_match('/^[a-f]$/', $h)) {
            $letterCols[$h] = $i;
        }
    }

    if ($isHeader) {
        array_shift($rows);                 // 去掉表头行
    } else {
        // 无表头时按旧版默认列序解析
        $header = array('type', 'stem', 'a', 'b', 'c', 'd', 'answer', 'analysis', 'tags');
        $letterCols = array('a' => 2, 'b' => 3, 'c' => 4, 'd' => 5);
    }

    $result = array();
    foreach ($rows as $row) {
        // 按列名取值（找不到就返回空）
        $get = function ($key) use ($row, $header, $aliases) {
            foreach ($aliases[$key] as $name) {
                $i = array_search(strtolower($name), $header, true);
                if ($i !== false && isset($row[$i])) {
                    $v = trim((string) $row[$i]);
                    if ($v !== '') return $v;
                }
            }
            return '';
        };

        $stem = $get('stem');
        if ($stem === '') continue;

        $type = normalize_type($get('type'));
        $answerRaw = $get('answer');
        if ($answerRaw === '') continue;

        // 选项：优先「每个选项一个单元格」（A/B/C/D/E/F 列）
        $options = array();
        foreach ($letterCols as $k => $i) {
            $v = isset($row[$i]) ? trim((string) $row[$i]) : '';
            if ($v !== '') {
                $options[] = array('key' => strtoupper($k), 'text' => $v);
            }
        }
        // 兜底：也支持把选项写在同一格（用 | 分隔），例如 A. 1|B. 2
        if (!$options) {
            $optStr = $get('options');
            if ($optStr !== '') {
                $parts = preg_split('/\s*[|｜]\s*/u', $optStr);
                $idx = 0;
                foreach ($parts as $p) {
                    $p = trim($p);
                    if ($p === '') continue;
                    if (preg_match('/^[\(（]?\s*([A-Fa-f])\s*[\)）]?\s*[\.、：:\)）]?\s*(.*)$/u', $p, $m)) {
                        $options[] = array('key' => strtoupper($m[1]), 'text' => trim($m[2]));
                    } else {
                        $options[] = array('key' => chr(65 + $idx), 'text' => $p);
                    }
                    $idx++;
                }
            }
        }

        // 判断题：选项只有 对/错 时自动识别（即便题型列写的是单选）
        if (count($options) === 2) {
            $k0 = judge_word_kind($options[0]['text']);
            $k1 = judge_word_kind($options[1]['text']);
            if ($k0 !== null && $k1 !== null && $k0 !== $k1) {
                $type = 'judge';
            }
        }
        if ($type === null) {
            // 没写题型：有选项=单选/多选，答案是"对/错"=判断，否则=填空
            if ($options) {
                $letters = preg_replace('/[^A-Za-z]/u', '', strtoupper($answerRaw));
                $type = strlen($letters) > 1 ? 'multiple' : 'single';
            } elseif (preg_match('/^(正确|错误|错|对|√|×|T|F)$/iu', $answerRaw)) {
                $type = 'judge';
            } else {
                $type = 'blank';
            }
        }
        if ($type === 'judge' && count($options) !== 2) {
            $options = array(
                array('key' => 'A', 'text' => '正确'),
                array('key' => 'B', 'text' => '错误'),
            );
        }

        $answers = parse_answer_str($answerRaw, $type, $options);
        if (!$answers) continue;

        $result[] = array(
            'type'     => $type,
            'stem'     => $stem,
            'options'  => $options,
            'answer'   => $answers,
            'analysis' => $get('analysis'),
            'tags'     => $get('tags'),
            'chapter'  => $get('chapter'),
        );
    }
    return $result;
}

/** JSON 导入 */
function parse_questions_json($content)
{
    $content = preg_replace('/^\xEF\xBB\xBF/', '', $content); // 去 BOM
    $data = json_decode($content, true);
    if (!is_array($data)) {
        return array();
    }
    if (isset($data['questions']) && is_array($data['questions'])) {
        $data = $data['questions'];
    }

    $result = array();
    foreach ($data as $item) {
        if (!is_array($item)) {
            continue;
        }
        $stem = trim(isset($item['stem']) ? $item['stem'] : (isset($item['question']) ? $item['question'] : ''));
        if ($stem === '') {
            continue;
        }
        $rawType = isset($item['type']) ? $item['type'] : '';
        $type    = normalize_type($rawType);

        $options = array();
        if (isset($item['options']) && is_array($item['options'])) {
            foreach ($item['options'] as $k => $v) {
                if (is_array($v)) {
                    $options[] = array(
                        'key'  => strtoupper((string) (isset($v['key']) ? $v['key'] : $k)),
                        'text' => (string) (isset($v['text']) ? $v['text'] : ''),
                    );
                } else {
                    $options[] = array('key' => strtoupper((string) $k), 'text' => (string) $v);
                }
            }
        }

        $answers = array();
        if (isset($item['answer'])) {
            $answers = is_array($item['answer']) ? $item['answer'] : array($item['answer']);
        }
        $answers = array_values(array_filter(array_map('trim', array_map('strval', $answers)), function ($x) { return $x !== ''; }));
        if ($type !== 'blank' && $type !== 'essay') {
            $answers = array_map('strtoupper', $answers);
        }

        if ($type === null) {
            $type = (count($answers) > 1 && $options) ? 'multiple' : ($options ? 'single' : 'blank');
        }
        if ($type === 'judge') {
            $options = array(
                array('key' => 'A', 'text' => '正确'),
                array('key' => 'B', 'text' => '错误'),
            );
        }
        if (!$answers) {
            continue;
        }

        $result[] = array(
            'type'     => $type,
            'stem'     => $stem,
            'options'  => $options,
            'answer'   => $answers,
            'analysis' => isset($item['analysis']) ? (string) $item['analysis'] : '',
            'tags'     => isset($item['tags']) ? (string) $item['tags'] : '',
        );
    }
    return $result;
}

/**
 * 把一段 HTML 转成「文本 + Markdown 图片」的安全富文本。
 * 注意：正文里可能出现 <10:1> 这类"像标签却又不是标签"的内容，
 * 所以不能用 strip_tags（会连同正文一起删掉），这里只移除白名单标签。
 */
function rich_from_html($html)
{
    $s = (string) $html;
    if ($s === '') return '';

    // 图片 -> Markdown
    $s = preg_replace('/<img\b[^>]*\bsrc\s*=\s*["\']([^"\']+)["\'][^>]*>/iu', "\n![]($1)\n", $s);
    // 换行类标签
    $s = preg_replace('/<br\s*\/?\s*>/iu', "\n", $s);
    $s = preg_replace('/<\/(p|div|li|tr|h[1-6]|table|blockquote)\s*>/iu', "\n", $s);

    // 只移除白名单里的 HTML 标签，其余内容（如 <10:1>）原样保留
    $tags = 'a|b|i|u|em|strong|span|font|div|p|br|hr|ul|ol|li|table|thead|tbody|tr|td|th|h[1-6]|sub|sup|small|code|pre|blockquote|section|article|figure|center';
    $s = preg_replace('/<\/?(?:' . $tags . ')\b[^>]*>/iu', '', $s);

    $s = html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $s = preg_replace('/[ \t\x{00A0}]+/u', ' ', $s);
    $s = preg_replace('/\n{3,}/u', "\n\n", $s);
    return trim($s);
}

/**
 * 誉天题库导出的 JSON 格式，结构示例：
 * [
 *   {
 *     "id": 155380, "parentId": "xxx", "number": 1, "type": "1",
 *     "title": "<div>题干，可含 <img src=\"https://...\"></div>",
 *     "optionA": "选项A", "optionB": "...", "optionC": null, "optionD": null,
 *     "optionE": null, "optionF": null,
 *     "answer": "A",      // type=1 单个字母；type=2 多个字母如 "ABCD"
 *     "analysis": null    // type=3 为填空题，answer 是文本答案
 *   }
 * ]
 * type: 1=单选  2=多选  3=填空
 */
/** 判断一个选项文本是不是「对/错」类判断词，返回 right/wrong 或 null */
function judge_word_kind($text)
{
    $t = trim((string) $text);
    if ($t === '') return null;
    if (preg_match('/^(正确|对|√|T|Y|TRUE|YES)$/iu', $t)) return 'right';
    if (preg_match('/^(错误|错|×|X|F|N|FALSE|NO)$/iu', $t)) return 'wrong';
    return null;
}

function parse_questions_yutian($content)
{
    $raw = trim($content);
    $raw = preg_replace('/^\xEF\xBB\xBF/', '', $raw); // 去 BOM
    $data = json_decode($raw, true);
    if (!is_array($data)) {
        return array();
    }
    // 兼容外面套一层的情况：{data:[...]} / {questions:[...]} / {list:[...]}
    foreach (array('data', 'questions', 'list', 'result', 'items') as $key) {
        if (isset($data[$key]) && is_array($data[$key])) {
            $data = $data[$key];
            break;
        }
    }

    $result = array();
    foreach ($data as $item) {
        if (!is_array($item)) continue;

        // 题干字段名兼容
        $title = '';
        foreach (array('title', 'question', 'stem', 'content', 'name') as $k) {
            if (isset($item[$k]) && trim((string) $item[$k]) !== '') { $title = (string) $item[$k]; break; }
        }
        $stem = rich_from_html($title);
        if ($stem === '') continue;

        // 答案
        $answerRaw = '';
        foreach (array('answer', 'answers', 'rightAnswer', 'correct') as $k) {
            if (isset($item[$k]) && trim((string) $item[$k]) !== '') { $answerRaw = trim((string) $item[$k]); break; }
        }
        if ($answerRaw === '') continue;

        // 选项（A-F）
        $options = array();
        foreach (array('A', 'B', 'C', 'D', 'E', 'F') as $k) {
            $v = isset($item['option' . $k]) ? trim(rich_from_html($item['option' . $k])) : '';
            if ($v !== '') $options[] = array('key' => $k, 'text' => $v);
        }

        // 题型
        $typeRaw = isset($item['type']) ? trim((string) $item['type']) : '';
        if (isset($item['questionType']) && $typeRaw === '') $typeRaw = trim((string) $item['questionType']);

        // 少数判断题被标成了 type=1，有两种形态：
        // a) 没有选项，答案是「正确/错误」
        // b) 只有两个选项，且选项文本是 对/错、正确/错误、√/× 等（此时保留原始选项文字）
        $judgeWords = '/^(正确|错误|错|对|√|×|T|F|Y|N|TRUE|FALSE|YES|NO)$/iu';
        $isJudge = false;
        if (!$options && preg_match($judgeWords, $answerRaw)) {
            $isJudge = true;
        } elseif (count($options) === 2) {
            $k0 = judge_word_kind($options[0]['text']);
            $k1 = judge_word_kind($options[1]['text']);
            if ($k0 !== null && $k1 !== null && $k0 !== $k1) {
                $isJudge = true;
            }
        }

        if ($isJudge) {
            $type = 'judge';
        } elseif ($typeRaw === '1' || $typeRaw === 'single' || $typeRaw === 'radio') {
            $type = 'single';
        } elseif ($typeRaw === '2' || $typeRaw === 'multiple' || $typeRaw === 'multi' || $typeRaw === 'checkbox') {
            $type = 'multiple';
        } elseif ($typeRaw === '3' || $typeRaw === 'blank' || $typeRaw === 'fill') {
            $type = 'blank';
        } elseif ($typeRaw === 'judge' || $typeRaw === '4') {
            $type = 'judge';
        } else {
            $type = $options ? 'single' : 'blank';
        }

        if ($isJudge) {
            // 判断题：答案可能是字母 A/B，也可能是文字「正确/错误」
            if (preg_match('/^[ABab]$/u', $answerRaw)) {
                $answers = array(strtoupper($answerRaw));
            } else {
                $answers = (preg_match('/^(错误|错|×|F|N|FALSE|NO)$/iu', $answerRaw)) ? array('B') : array('A');
            }
            // 没有选项时补默认的 正确/错误；有 对/错 选项则保留原始文字
            if (count($options) !== 2) {
                $options = array(
                    array('key' => 'A', 'text' => '正确'),
                    array('key' => 'B', 'text' => '错误'),
                );
            }
        } elseif ($type === 'blank' || $type === 'essay') {
            // 填空题：多个空用 | 或中英文逗号分隔
            $answers = preg_split('/\s*\|\s*|\s*[，,]\s*/u', $answerRaw);
            $answers = array_values(array_filter(array_map('trim', $answers), function ($x) { return $x !== ''; }));
            if (!$answers) $answers = array($answerRaw);
        } else {
            // 客观题：答案里可能有 "A" 或 "AB"，也可能带空格/顿号
            $letters = preg_replace('/[^A-Za-z]/u', '', strtoupper($answerRaw));
            $answers = $letters === '' ? array() : str_split($letters);
            if (!$answers) continue;
            // 单选里出现多个字母，按多选处理
            if ($type === 'single' && count($answers) > 1) $type = 'multiple';
        }

        // 注意：判断题的选项在上面 isJudge 分支里已处理（保留 对/错 原文）

        $analysis = '';
        foreach (array('analysis', 'explain', 'parse', 'remark') as $k) {
            if (!empty($item[$k])) { $analysis = rich_from_html($item[$k]); break; }
        }

        $tags = isset($item['tags']) ? trim((string) $item['tags']) : '';

        $result[] = array(
            'type'     => $type,
            'stem'     => $stem,
            'options'  => $options,
            'answer'   => $answers,
            'analysis' => $analysis,
            'tags'     => $tags,
        );
    }
    return $result;
}

function normalize_type($raw)
{
    $raw = trim((string) $raw);
    if ($raw === '') {
        return null;
    }
    if (strpos($raw, '多选') !== false) return 'multiple';
    if (strpos($raw, '单选') !== false) return 'single';
    if (strpos($raw, '判断') !== false) return 'judge';
    if (strpos($raw, '填空') !== false) return 'blank';
    if (strpos($raw, '简答') !== false) return 'essay';

    switch (strtolower($raw)) {
        case 'single':
        case 'radio':
            return 'single';
        case 'multiple':
        case 'multi':
        case 'checkbox':
            return 'multiple';
        case 'judge':
        case 'boolean':
        case 'tf':
            return 'judge';
        case 'blank':
        case 'fill':
            return 'blank';
        case 'essay':
        case 'qa':
            return 'essay';
    }
    return null;
}
