<?php
declare(strict_types=1);

ob_start();

require_once __DIR__ . '/lib/Compat.php';
require_once __DIR__ . '/lib/Auth.php';
require_once __DIR__ . '/lib/Version.php';

try {
    Auth::boot();
    $version = Version::load(__DIR__ . '/version.xk');
    $auth = new Auth(__DIR__ . '/data');

    // Sin sesión no se muestra ni se procesa nada: siempre al login.
    $currentUser = empty($_SESSION['uid']) ? null : $auth->currentUser();
    if (!$currentUser) {
        ob_end_clean();
        header('Cache-Control: no-store, no-cache, must-revalidate');
        header('Pragma: no-cache');
        header('Location: ' . Auth::basePath() . 'login.php', true, 302);
        exit;
    }
} catch (Throwable $ex) {
    error_log('GesKua: ' . $ex->getMessage());
    ob_end_clean();
    http_response_code(500);
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-store');
    echo '<!doctype html><html lang="es"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width, initial-scale=1">'
        . '<title>GesKua · Error</title></head>'
        . '<body style="font-family:system-ui,-apple-system,sans-serif;padding:40px;max-width:640px;margin:auto;color:#102433">'
        . '<h1 style="font-size:22px">No se pudo iniciar la aplicación</h1>'
        . '<p>Revisa que PHP pueda leer y escribir en <code>geskua/data/</code> y que el servidor use PHP 8.1 o superior.</p>'
        . '</body></html>';
    exit;
}

header('Cache-Control: no-store');
$roleLabels = [
    'admin' => 'Superadministrador',
    'editor' => 'Administrador',
    'colaborador' => 'Colaborador',
    'lector' => 'Lector',
];
$roleLabel = $roleLabels[$currentUser['role']] ?? $roleLabels['editor'];
$userInitials = mb_strtoupper(mb_substr($currentUser['username'], 0, 2, 'UTF-8'), 'UTF-8');
$e = static fn ($v): string => htmlspecialchars((string)$v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
$userJson = json_encode($currentUser, JSON_UNESCAPED_UNICODE | JSON_HEX_TAG | JSON_HEX_AMP | JSON_HEX_APOS | JSON_HEX_QUOT);
?>
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#0f766e">
<title>GesKua · Personal y flota</title>
<link rel="manifest" href="manifest.json">
<link rel="icon" type="image/png" sizes="192x192" href="assets/icon-192.png">
<link rel="apple-touch-icon" href="assets/icon-192.png">
<link rel="stylesheet" href="assets/app.css?v=26">
</head>
<body class="<?= $currentUser['role'] === 'lector' ? 'role-lector' : '' ?>">
<svg class="sprite" aria-hidden="true">
    <symbol id="i-grid" viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></symbol>
    <symbol id="i-users" viewBox="0 0 24 24"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></symbol>
    <symbol id="i-bus" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M3 10h18M8 17v3M16 17v3M7 21h.01M17 21h.01"/><circle cx="7.5" cy="14" r="1"/><circle cx="16.5" cy="14" r="1"/></symbol>
    <symbol id="i-clock" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></symbol>
    <symbol id="i-chart" viewBox="0 0 24 24"><path d="M3 3v18h18"/><path d="M7 15v3M12 10v8M17 6v12"/></symbol>
    <symbol id="i-cog" viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1z"/></symbol>
    <symbol id="i-shield" viewBox="0 0 24 24"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="m9 11 2.2 2.2L15.5 9"/></symbol>
    <symbol id="i-chevron-left" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></symbol>
    <symbol id="i-chevron-right" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></symbol>
    <symbol id="i-chevron-down" viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></symbol>
    <symbol id="i-plus" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></symbol>
    <symbol id="i-search" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></symbol>
    <symbol id="i-download" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></symbol>
    <symbol id="i-upload" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 8l5-5 5 5M12 3v12"/></symbol>
    <symbol id="i-print" viewBox="0 0 24 24"><path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></symbol>
    <symbol id="i-close" viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></symbol>
    <symbol id="i-check" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></symbol>
    <symbol id="i-warning" viewBox="0 0 24 24"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></symbol>
    <symbol id="i-trash" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6"/></symbol>
    <symbol id="i-edit" viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></symbol>
    <symbol id="i-calendar" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></symbol>
    <symbol id="i-sparkles" viewBox="0 0 24 24"><path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 2l.7 1.6L7.3 4.3 5.7 5 5 6.6 4.3 5 2.7 4.3 4.3 3.6z"/></symbol>
    <symbol id="i-filter" viewBox="0 0 24 24"><path d="M22 3H2l8 9.5V19l4 2v-8.5z"/></symbol>
    <symbol id="i-more" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></symbol>
    <symbol id="i-arrow-left" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7"/></symbol>
    <symbol id="i-undo" viewBox="0 0 24 24"><path d="M3 7v6h6"/><path d="M3.5 13a9 9 0 1 0 2.1-9.4L3 7"/></symbol>
    <symbol id="i-key" viewBox="0 0 24 24"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2.5 2.5"/></symbol>
    <symbol id="i-logout" viewBox="0 0 24 24"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/></symbol>
</svg>

<div class="layout">
    <aside class="sidebar">
        <div class="brand">
            <div class="brand-mark">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10M4 12h16M7 21v-4M17 21v-4"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/></svg>
            </div>
            <div class="brand-text">
                <strong>GesKua</strong>
                <span>Personal y flota</span>
            </div>
        </div>
        <nav class="nav" id="nav" aria-label="Secciones">
            <button type="button" class="nav-item" data-view="cuadrante">
                <svg><use href="#i-grid"/></svg><span>Cuadrante</span>
            </button>
            <button type="button" class="nav-item" data-view="personal">
                <svg><use href="#i-users"/></svg><span>Personal</span><em id="nav-drivers"></em>
            </button>
            <button type="button" class="nav-item" data-view="flota">
                <svg><use href="#i-bus"/></svg><span>Flota</span><em id="nav-vehicles"></em>
            </button>
            <button type="button" class="nav-item" data-view="turnos">
                <svg><use href="#i-clock"/></svg><span>Turnos</span><em id="nav-shifts"></em>
            </button>
            <?php if (in_array($currentUser['role'], ['admin', 'editor'], true)): ?>
            <button type="button" class="nav-item" data-view="usuarios">
                <svg><use href="#i-shield"/></svg><span>Usuarios</span>
            </button>
            <?php endif; ?>
            <button type="button" class="nav-item" data-view="resumen">
                <svg><use href="#i-chart"/></svg><span>Resumen</span>
            </button>
            <button type="button" class="nav-item" data-view="ajustes">
                <svg><use href="#i-cog"/></svg><span>Ajustes</span>
            </button>
        </nav>
        <div class="sidebar-foot">
            <div class="mini-legend">
                <span><i class="dot dot-work"></i>Turno</span>
                <span><i class="dot dot-rest"></i>Descanso</span>
                <span><i class="dot dot-vac"></i>Vacaciones</span>
                <span><i class="dot dot-sick"></i>Baja</span>
            </div>
        </div>
    </aside>

    <div class="main">
        <header class="topbar">
            <div class="topbar-title">
                <h1 id="page-title">Cuadrante mensual</h1>
                <p id="page-subtitle">Carga completa</p>
            </div>
            <div class="month-control" aria-label="Mes de trabajo">
                <button type="button" class="icon-btn" id="month-prev" title="Mes anterior">
                    <svg><use href="#i-chevron-left"/></svg>
                </button>
                <label class="month-input" for="month-picker">
                    <svg><use href="#i-calendar"/></svg>
                    <input type="month" id="month-picker" min="2020-01" max="2035-12">
                </label>
                <button type="button" class="icon-btn" id="month-next" title="Mes siguiente">
                    <svg><use href="#i-chevron-right"/></svg>
                </button>
                <button type="button" class="btn btn-ghost btn-sm" id="month-today">Hoy</button>
            </div>
            <div class="topbar-actions">
                <span class="save-state" id="save-state"><i></i><b>Guardado</b></span>
                <div class="user-menu" id="user-menu">
                    <button type="button" class="user-chip" id="user-chip" aria-haspopup="menu" aria-expanded="false">
                        <span class="avatar sm" id="user-initials"><?= $e($userInitials) ?></span>
                        <span class="user-chip-text">
                            <b id="user-name"><?= $e($currentUser['username']) ?></b>
                            <small id="user-role"><?= $e($roleLabel) ?></small>
                        </span>
                        <svg class="user-caret"><use href="#i-chevron-down"/></svg>
                    </button>
                    <div class="user-dropdown" id="user-dropdown" role="menu" hidden>
                        <div class="user-dropdown-head">
                            <b id="user-dropdown-name"><?= $e($currentUser['username']) ?></b>
                            <span id="user-dropdown-role"><?= $e($roleLabel) ?></span>
                        </div>
                        <button type="button" role="menuitem" data-profile>
                            <svg><use href="#i-key"/></svg> Cambiar contraseña
                        </button>
                        <button type="button" role="menuitem" class="danger" data-logout>
                            <svg><use href="#i-logout"/></svg> Cerrar sesión
                        </button>
                    </div>
                </div>
            </div>
        </header>
        <main id="view" class="view" aria-live="polite">
            <div class="loading">
                <div class="spinner"></div>
                <p>Cargando cuadrantes…</p>
            </div>
        </main>
    </div>
</div>

<div id="modal-root"></div>
<div id="drawer-root"></div>
<div id="toast-root" class="toast-root" aria-live="polite"></div>

<div class="app-signature" aria-label="Aplicación y versión">
    <span class="app-signature-title"><?= $e(Version::title($version)) ?></span>
    <?php if ($version['author'] !== ''): ?>
    <span class="app-signature-author"><?= $e($version['author']) ?></span>
    <?php endif; ?>
</div>

<script>window.GESTION = { base: '.', user: <?= $userJson ?> };</script>
<script src="assets/base.js?v=26"></script>
<script src="assets/auth.js?v=26"></script>
<script src="assets/xlsx.full.min.js?v=26"></script>
<script src="assets/app.js?v=26"></script>
<script src="assets/view-cuadrante.js?v=26"></script>
<script src="assets/view-admin.js?v=26"></script>
<script src="assets/view-analytics.js?v=26"></script>
<script src="assets/view-users.js?v=26"></script>
</body>
</html>
