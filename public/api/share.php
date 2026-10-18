<?php
// 閲覧専用リンク用：共有IDから進捗を読むだけ（書き換えはできない）
declare(strict_types=1);
require __DIR__ . '/lib.php';

$id = (string)($_GET['id'] ?? '');
if (!preg_match('/^[a-f0-9]{16}$/', $id)) {
    json_out(400, ['error' => 'bad_id']);
}
rate_limit();

$stmt = db()->prepare('SELECT data, updated_at FROM progress WHERE share_id = ?');
$stmt->execute([$id]);
$row = $stmt->fetch();
if (!$row) {
    json_out(404, ['error' => 'not_found']);
}
json_out(200, [
    'profiles' => (object)sanitize_profiles(json_decode($row['data'], true)),
    'updatedAt' => (int)$row['updated_at'],
]);
