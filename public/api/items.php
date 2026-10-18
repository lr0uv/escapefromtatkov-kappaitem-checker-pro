<?php
// Collector（Kappa）の納品アイテム一覧を返す。
// tarkov.dev の JSON API（json.tarkov.dev）から取得した結果を数時間ファイルに保存して使い回す。
// アイテム追加は自動で反映される。※GraphQL API（api.tarkov.dev）は2026年7月から停止中のため使わない。
declare(strict_types=1);
require __DIR__ . '/lib.php';

$mode = in_array($_GET['mode'] ?? '', ['regular', 'pve', 'pvp-season'], true) ? $_GET['mode'] : 'regular';
$cacheFile = data_dir() . "/collector-$mode.json";
$cached = is_file($cacheFile) ? file_get_contents($cacheFile) : false;

if ($cached !== false && time() - filemtime($cacheFile) < CACHE_TTL) {
    send_items($cached);
}

// tarkov.dev が落ちているときに、アクセスのたびに問い合わせ続けないよう1分は待つ
$failFile = data_dir() . "/collector-$mode.failed";
if (is_file($failFile) && time() - filemtime($failFile) < 60) {
    if ($cached !== false) send_items($cached);
    json_out(503, ['error' => 'items_unavailable', 'detail' => file_get_contents($failFile)]);
}

// 同時に何人もアクセスしても、tarkov.dev へ問い合わせるのは1回だけにする
$failure = 'busy';
$lock = fopen(data_dir() . "/collector-$mode.lock", 'c');
if ($lock && flock($lock, LOCK_EX | LOCK_NB)) {
    try {
        $fresh = json_encode(fetch_collector($mode), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        file_put_contents($cacheFile . '.tmp', $fresh);
        rename($cacheFile . '.tmp', $cacheFile);
        send_items($fresh);
    } catch (Throwable $e) {
        $failure = $e->getMessage();
        file_put_contents($failFile, $failure);
        error_log('kcc items fetch failed: ' . $failure);
    } finally {
        flock($lock, LOCK_UN);
    }
}

// 取得に失敗しても、前回の一覧があればそれを返す
if ($cached !== false) {
    send_items($cached);
}
json_out(503, ['error' => 'items_unavailable', 'detail' => $failure]);

function send_items(string $json): never {
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: public, max-age=600');
    echo $json;
    exit;
}

function fetch_json(string $path): array {
    $url = rtrim(getenv('KCC_TARKOV_JSON') ?: TARKOV_JSON, '/') . '/' . $path;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_ENCODING => '',          // gzip圧縮で受け取る（転送量が約1/8になる）
        CURLOPT_TIMEOUT => 30,
        CURLOPT_HTTPHEADER => ['Accept: application/json', 'User-Agent: kappacontainer.com'],
    ]);
    $res = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $netError = curl_error($ch);
    curl_close($ch);
    if ($res === false || $status !== 200) throw new RuntimeException("$path: HTTP $status $netError");
    $json = json_decode($res, true);
    if (!is_array($json) || !isset($json['data'])) throw new RuntimeException("$path: bad response");
    return $json['data'];
}

function fetch_collector(string $mode): array {
    // 名前などの文字は「<ID> Name」のようなキーになっていて、言語ごとのファイルで本当の文字に置き換える
    $tasks = fetch_json("$mode/tasks")['tasks'] ?? [];
    $task = null;
    foreach ($tasks as $t) {
        if (($t['normalizedName'] ?? '') === 'collector') { $task = $t; break; }
    }
    if (!$task) throw new RuntimeException('collector task not found');

    $taskNames = ['ja' => fetch_json("$mode/tasks_ja"), 'en' => fetch_json("$mode/tasks_en")];
    $itemNames = ['ja' => fetch_json("$mode/items_ja"), 'en' => fetch_json("$mode/items_en")];
    $tr = fn(array $dict, string $key) => $dict[$key] ?? null;

    $items = [];
    $objectives = array_filter($task['objectives'] ?? [], fn($o) => ($o['type'] ?? '') === 'giveItem' && !empty($o['items']));
    foreach ($objectives as $o) {
        $id = is_array($o['items'][0]) ? $o['items'][0]['id'] : $o['items'][0];
        if (isset($items[$id]) || !preg_match('/^[a-f0-9]{24}$/', $id)) continue;
        $en = $tr($itemNames['en'], "$id Name") ?? $id;
        $items[$id] = [
            'id' => $id,
            'name' => ['ja' => $tr($itemNames['ja'], "$id Name") ?? $en, 'en' => $en],
            'short' => [
                'ja' => $tr($itemNames['ja'], "$id ShortName") ?? '',
                'en' => $tr($itemNames['en'], "$id ShortName") ?? '',
            ],
            'icon' => "https://assets.tarkov.dev/$id-icon.webp",
            'image' => "https://assets.tarkov.dev/$id-512.webp",
            'count' => (int)($o['count'] ?? 1),
            'fir' => (bool)($o['foundInRaid'] ?? true),
        ];
    }
    // 一覧が極端に少ないときはデータ側の不具合とみなし、保存しない
    if (count($items) < 10) throw new RuntimeException('too few items: ' . count($items));

    $nameKey = $task['name'] ?? '';
    return [
        'mode' => $mode,
        'updatedAt' => time(),
        'task' => ['id' => $task['id'], 'name' => [
            'ja' => $tr($taskNames['ja'], $nameKey) ?? 'Collector',
            'en' => $tr($taskNames['en'], $nameKey) ?? 'Collector',
        ]],
        'items' => array_values($items),
    ];
}
