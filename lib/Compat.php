<?php
declare(strict_types=1);

/**
 * Compatibilidad para servidores sin la extensión mbstring.
 *
 * GesKua solo necesita medir, recortar y cambiar de caja cadenas UTF-8.
 * Si mbstring no está disponible, se usan iconv o PCRE como respaldo.
 * Las funciones nativas siempre tienen prioridad cuando la extensión existe.
 */

if (!function_exists('mb_strlen')) {
    function mb_strlen(string $string, ?string $encoding = null): int
    {
        if (function_exists('iconv_strlen')) {
            $length = @iconv_strlen($string, $encoding ?: 'UTF-8');
            if ($length !== false) {
                return $length;
            }
        }
        $count = preg_match_all('/./us', $string);
        return $count === false ? strlen($string) : $count;
    }
}

if (!function_exists('mb_substr')) {
    function mb_substr(string $string, int $start, ?int $length = null, ?string $encoding = null): string
    {
        if (function_exists('iconv_substr')) {
            $chunk = @iconv_substr($string, $start, $length ?? PHP_INT_MAX, $encoding ?: 'UTF-8');
            if ($chunk !== false) {
                return $chunk;
            }
        }
        $chars = preg_split('//u', $string, -1, PREG_SPLIT_NO_EMPTY);
        if ($chars === false) {
            return $length === null ? substr($string, $start) : substr($string, $start, $length);
        }
        $slice = $length === null ? array_slice($chars, $start) : array_slice($chars, $start, $length);
        return implode('', $slice);
    }
}

if (!function_exists('mb_strtoupper')) {
    function mb_strtoupper(string $string, ?string $encoding = null): string
    {
        static $map = [
            'á' => 'Á', 'é' => 'É', 'í' => 'Í', 'ó' => 'Ó', 'ú' => 'Ú', 'ü' => 'Ü',
            'ñ' => 'Ñ', 'ç' => 'Ç', 'à' => 'À', 'è' => 'È', 'ì' => 'Ì', 'ò' => 'Ò',
            'ù' => 'Ù', 'ä' => 'Ä', 'ë' => 'Ë', 'ï' => 'Ï', 'ö' => 'Ö', 'â' => 'Â',
            'ê' => 'Ê', 'î' => 'Î', 'ô' => 'Ô', 'û' => 'Û',
        ];
        return strtr(strtoupper($string), $map);
    }
}

if (!function_exists('mb_strtolower')) {
    function mb_strtolower(string $string, ?string $encoding = null): string
    {
        static $map = [
            'Á' => 'á', 'É' => 'é', 'Í' => 'í', 'Ó' => 'ó', 'Ú' => 'ú', 'Ü' => 'ü',
            'Ñ' => 'ñ', 'Ç' => 'ç', 'À' => 'à', 'È' => 'è', 'Ì' => 'ì', 'Ò' => 'ò',
            'Ù' => 'ù', 'Ä' => 'ä', 'Ë' => 'ë', 'Ï' => 'ï', 'Ö' => 'ö', 'Â' => 'â',
            'Ê' => 'ê', 'Î' => 'î', 'Ô' => 'ô', 'Û' => 'û',
        ];
        return strtr(strtolower($string), $map);
    }
}
