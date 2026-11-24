<?php
declare(strict_types=1);

/**
 * Lee la firma de la aplicación desde version.xk.
 *
 * El archivo tiene dos líneas:
 *   GesKua v.1.261123.0-b26 beta
 *   B174M3 // XaeK
 *
 * La primera contiene el nombre y la versión; la segunda, el creador.
 */
final class Version
{
    /** @return array{name:string,version:string,author:string,raw:string} */
    public static function load(string $file): array
    {
        $info = ['name' => '', 'version' => '', 'author' => '', 'raw' => ''];
        if (!is_file($file) || !is_readable($file)) {
            return $info;
        }

        $raw = (string)file_get_contents($file);
        $info['raw'] = trim($raw);

        $lines = preg_split('/\R/', $raw) ?: [];
        $lines = array_values(array_filter(array_map('trim', $lines), static fn (string $l): bool => $l !== ''));

        $first = $lines[0] ?? '';
        if ($first !== '') {
            // Acepta números clásicos (0.2.1), bloques diarios compactos
            // (1.261123.0, 261123) y su extensión con base (1.261123.0-b26).
            if (preg_match('/^(.*?)\s+v?\.?\s*([0-9][0-9A-Za-z.\-]*)\s*(.*)$/i', $first, $m) === 1) {
                $info['name'] = trim($m[1]);
                $suffix = trim($m[3]);
                $info['version'] = trim($m[2] . ($suffix !== '' ? ' ' . $suffix : ''));
            } else {
                $info['name'] = $first;
            }
        }
        $info['author'] = $lines[1] ?? '';

        return $info;
    }

    /** Línea corta para la firma: «GesKua v.1.261123.0-b26 beta». */
    public static function title(array $info): string
    {
        $name = (string)($info['name'] ?? '');
        $version = (string)($info['version'] ?? '');
        if ($name === '') {
            return (string)($info['raw'] ?? '');
        }
        return $version === '' ? $name : $name . ' v.' . $version;
    }
}
