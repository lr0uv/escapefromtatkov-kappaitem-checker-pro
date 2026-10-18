<?php
// Collector（Kappa）の納品アイテム一覧を返す。
// tarkov.dev から取得した結果を数時間ファイルに保存して使い回す（アイテム追加は自動で反映される）。
declare(strict_types=1);
require __DIR__ . '/lib.php';

$mode = ($_GET['mode'] ?? 'regular') === 'pve' ? 'pve' : 'regular';
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

function graphql(string $query): array {
    $url = getenv('KCC_TARKOV_API') ?: TARKOV_API;
    $payload = json_encode(['query' => $query]);
    $headers = ['Content-Type: application/json', 'Accept: application/json', 'User-Agent: kappacontainer.com'];
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => $payload,
            CURLOPT_HTTPHEADER => $headers,
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 20,
        ]);
        $res = curl_exec($ch);
        $netError = curl_error($ch);
        curl_close($ch);
    } else {
        $ctx = stream_context_create(['http' => [
            'method' => 'POST',
            'header' => implode("\r\n", $headers) . "\r\n",
            'content' => $payload,
            'timeout' => 20,
        ]]);
        $res = file_get_contents($url, false, $ctx);
        $netError = error_get_last()['message'] ?? '';
    }
    if ($res === false || $res === '') throw new RuntimeException('request failed: ' . $netError);
    $json = json_decode($res, true);
    if (!is_array($json) || !isset($json['data'])) {
        $msg = $json['errors'][0]['message'] ?? substr((string)$res, 0, 200);
        throw new RuntimeException('bad response: ' . $msg);
    }
    return $json['data'];
}

function fetch_collector(string $mode): array {
    $fields = 'id normalizedName name objectives { type ... on TaskObjectiveItem { count foundInRaid items { id name shortName iconLink image512pxLink wikiLink } } }';
    $data = graphql("{ ja: tasks(lang: ja, gameMode: $mode) { $fields } en: tasks(lang: en, gameMode: $mode) { $fields } }");

    $pick = function (array $tasks): ?array {
        foreach ($tasks as $t) {
            if (($t['normalizedName'] ?? '') === 'collector') return $t;
        }
        return null;
    };
    $ja = $pick($data['ja'] ?? []);
    $en = $pick($data['en'] ?? []);
    if (!$ja || !$en) throw new RuntimeException('collector task not found');

    $enNames = [];
    foreach (collector_items($en) as $it) {
        $enNames[$it['item']['id']] = $it['item'];
    }

    $items = [];
    foreach (collector_items($ja) as $it) {
        $i = $it['item'];
        $e = $enNames[$i['id']] ?? $i;
        $items[] = [
            'id' => $i['id'],
            'name' => ['ja' => $i['name'], 'en' => $e['name']],
            'short' => ['ja' => $i['shortName'], 'en' => $e['shortName']],
            'icon' => $i['iconLink'],
            'image' => $i['image512pxLink'],
            'wiki' => $e['wikiLink'] ?? null,
            'count' => $it['count'],
            'fir' => $it['fir'],
        ];
    }
    // 一覧が極端に少ないときはAPI側の不具合とみなし、保存しない
    if (count($items) < 10) throw new RuntimeException('too few items: ' . count($items));

    return [
        'mode' => $mode,
        'updatedAt' => time(),
        'task' => ['id' => $ja['id'], 'name' => ['ja' => $ja['name'], 'en' => $en['name']]],
        'items' => $items,
    ];
}

// 「渡す（giveItem）」目標のアイテムを重複なしで取り出す
function collector_items(array $task): array {
    $objectives = array_filter($task['objectives'] ?? [], fn($o) => !empty($o['items']));
    $give = array_filter($objectives, fn($o) => ($o['type'] ?? '') === 'giveItem');
    $list = [];
    foreach ($give ?: $objectives as $o) {
        $item = $o['items'][0];
        if (isset($list[$item['id']])) continue;
        $list[$item['id']] = ['item' => $item, 'count' => (int)($o['count'] ?? 1), 'fir' => (bool)($o['foundInRaid'] ?? true)];
    }
    return array_values($list);
}
