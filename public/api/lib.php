<?php
// 共通処理：設定・JSON応答・データ保存先・SQLite接続
declare(strict_types=1);

const TARKOV_JSON = 'https://json.tarkov.dev';
const CACHE_TTL = 6 * 3600;          // アイテム一覧を取り直す間隔（秒）
const MAX_BODY_BYTES = 64 * 1024;    // 同期で受け付ける最大サイズ
const PROFILES = ['regular', 'pve', 'season'];
const RATE_LIMIT = 120;              // 同じIPから10分間に受け付ける回数
const RATE_WINDOW = 600;

function data_dir(): string {
    $dir = __DIR__ . '/_data';
    if (!is_dir($dir)) {
        mkdir($dir, 0700, true);
    }
    return $dir;
}

function json_out(int $status, array $body): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function db(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    $pdo = new PDO('sqlite:' . data_dir() . '/sync.sqlite', null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA busy_timeout = 3000');
    $pdo->exec('CREATE TABLE IF NOT EXISTS progress (
        key_hash TEXT PRIMARY KEY,
        share_id TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    )');
    $pdo->exec('CREATE TABLE IF NOT EXISTS hits (
        ip_hash TEXT NOT NULL,
        window INTEGER NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (ip_hash, window)
    )');
    return $pdo;
}

// IPアドレスそのものは保存せず、ハッシュ（元に戻せない変換）だけを使う
function rate_limit(): void {
    $window = intdiv(time(), RATE_WINDOW);
    $ip = hash('sha256', 'ip:' . ($_SERVER['REMOTE_ADDR'] ?? ''));
    $pdo = db();
    $pdo->prepare('INSERT INTO hits (ip_hash, window, count) VALUES (?, ?, 1)
        ON CONFLICT(ip_hash, window) DO UPDATE SET count = count + 1')->execute([$ip, $window]);
    $stmt = $pdo->prepare('SELECT count FROM hits WHERE ip_hash = ? AND window = ?');
    $stmt->execute([$ip, $window]);
    if ((int)$stmt->fetchColumn() > RATE_LIMIT) {
        json_out(429, ['error' => 'rate_limited']);
    }
    if (random_int(1, 50) === 1) {
        $pdo->prepare('DELETE FROM hits WHERE window < ?')->execute([$window - 1]);
    }
}

// 合言葉は「XXXX-XXXX-XXXX-XXXX-XXXX」（読み間違えにくい32種類の文字）
function normalize_key(string $raw): ?string {
    $s = strtoupper(preg_replace('/[^0-9A-Za-z]/', '', $raw));
    $s = strtr($s, ['O' => '0', 'I' => '1', 'L' => '1']);
    if (!preg_match('/^[0-9A-HJKMNP-TV-Z]{20}$/', $s)) return null;
    return implode('-', str_split($s, 4));
}

function key_hash(string $key): string {
    return hash('sha256', 'kcc-key:' . $key);
}

function share_id(string $key): string {
    return substr(hash('sha256', 'kcc-share:' . $key), 0, 16);
}

// 進捗データ：{ profiles: { regular: { itemId: [0|1, 更新時刻ms] } } }
function sanitize_profiles($input): array {
    $out = [];
    if (!is_array($input)) return $out;
    foreach (PROFILES as $p) {
        if (!isset($input[$p]) || !is_array($input[$p])) continue;
        $count = 0;
        foreach ($input[$p] as $id => $entry) {
            if (!is_string($id) || !preg_match('/^[a-f0-9]{24}$/', $id)) continue;
            if (!is_array($entry) || count($entry) !== 2) continue;
            [$v, $ts] = $entry;
            if (!is_int($ts) || $ts < 0) continue;
            $out[$p][$id] = [$v ? 1 : 0, $ts];
            if (++$count >= 500) break;
        }
    }
    return $out;
}

// アイテムごとに「新しい方の操作」を採用して2つの進捗を合わせる
function merge_profiles(array $a, array $b): array {
    $out = $a;
    foreach ($b as $p => $items) {
        foreach ($items as $id => $entry) {
            if (!isset($out[$p][$id]) || $entry[1] > $out[$p][$id][1]) {
                $out[$p][$id] = $entry;
            }
        }
    }
    return $out;
}
