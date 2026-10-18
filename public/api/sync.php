<?php
// 合言葉で進捗を同期する。端末の進捗とサーバーの進捗を合わせて、結果を返す。
declare(strict_types=1);
require __DIR__ . '/lib.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    json_out(405, ['error' => 'method_not_allowed']);
}
$raw = file_get_contents('php://input', false, null, 0, MAX_BODY_BYTES + 1);
if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
    json_out(413, ['error' => 'too_large']);
}
$body = json_decode($raw, true);
if (!is_array($body)) {
    json_out(400, ['error' => 'bad_json']);
}

rate_limit();

$key = normalize_key((string)($body['key'] ?? ''));
if ($key === null) {
    json_out(400, ['error' => 'bad_key']);
}
$incoming = sanitize_profiles($body['profiles'] ?? []);
$join = !empty($body['join']); // true＝既存の合言葉に接続（無ければエラー）

$pdo = db();
$hash = key_hash($key);
$pdo->beginTransaction();
$stmt = $pdo->prepare('SELECT data FROM progress WHERE key_hash = ?');
$stmt->execute([$hash]);
$row = $stmt->fetch();

if (!$row && $join) {
    $pdo->rollBack();
    json_out(404, ['error' => 'not_found']);
}

$stored = $row ? sanitize_profiles(json_decode($row['data'], true)) : [];
$merged = merge_profiles($stored, $incoming);
$now = time();

if (!$row) {
    $pdo->prepare('INSERT INTO progress (key_hash, share_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        ->execute([$hash, share_id($key), json_encode($merged), $now, $now]);
} elseif ($merged !== $stored) {
    $pdo->prepare('UPDATE progress SET data = ?, updated_at = ? WHERE key_hash = ?')
        ->execute([json_encode($merged), $now, $hash]);
}
$pdo->commit();

json_out(200, ['key' => $key, 'shareId' => share_id($key), 'profiles' => (object)$merged]);
