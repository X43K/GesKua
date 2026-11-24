<?php
declare(strict_types=1);

ob_start();

require_once __DIR__ . '/lib/Compat.php';
require_once __DIR__ . '/lib/Auth.php';
require_once __DIR__ . '/lib/Version.php';

$e = static fn ($v): string => htmlspecialchars((string)$v, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
$version = Version::load(__DIR__ . '/version.xk');
$needsSetup = false;
$error = '';

try {
    Auth::boot();
    $auth = new Auth(__DIR__ . '/data');

    if (session_status() !== PHP_SESSION_ACTIVE) {
        $error = 'El servidor no pudo iniciar la sesión. Revisa session.save_path en la configuración de PHP.';
    } elseif (!empty($_SESSION['uid']) && $auth->currentUser()) {
        ob_end_clean();
        header('Cache-Control: no-store, no-cache, must-revalidate');
        header('Location: ' . Auth::basePath(), true, 302);
        exit;
    } else {
        $needsSetup = $auth->needsSetup();
        if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'POST') {
            $logged = $auth->login(trim((string)($_POST['username'] ?? '')), (string)($_POST['password'] ?? ''));
            if ($logged) {
                ob_end_clean();
                header('Cache-Control: no-store, no-cache, must-revalidate');
                header('Location: ' . Auth::basePath(), true, 302);
                exit;
            }
            $error = 'Usuario o contraseña incorrectos.';
        }
    }
} catch (Throwable $ex) {
    error_log('GesKua login: ' . $ex->getMessage());
    $error = 'No se pudo leer el almacén de usuarios. Revisa los permisos de geskua/data/.';
}
header('Cache-Control: no-store');
?>
<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="theme-color" content="#0f766e">
<title>Acceso · GesKua</title>
<link rel="manifest" href="manifest.json">
<link rel="icon" type="image/png" sizes="192x192" href="assets/icon-192.png">
<link rel="apple-touch-icon" href="assets/icon-192.png">
<link rel="stylesheet" href="assets/login.css?v=26">
</head>
<body>
<main class="login-wrap">
    <section class="login-card" aria-labelledby="login-title">
        <div class="login-brand">
            <span class="login-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24"><path d="M4 17V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v10M4 12h16M7 21v-4M17 21v-4"/><circle cx="8" cy="15" r="1"/><circle cx="16" cy="15" r="1"/></svg>
            </span>
            <div>
                <strong>GesKua</strong>
                <span>Personal y flota</span>
            </div>
        </div>

        <div class="login-head">
            <h1 id="login-title">Iniciar sesión</h1>
            <p>Accede con tu cuenta para gestionar cuadrantes, personal y flota.</p>
        </div>

        <form id="login-form" method="post" action="login.php" novalidate>
            <div class="login-field">
                <label for="login-user">Usuario</label>
                <input id="login-user" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
            </div>
            <div class="login-field">
                <label for="login-pass">Contraseña</label>
                <input id="login-pass" name="password" type="password" autocomplete="current-password" required>
            </div>
            <p class="login-error" id="login-error" role="alert" <?= $error === '' ? 'hidden' : '' ?>><?= htmlspecialchars($error, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') ?></p>
            <button type="submit" class="login-submit" id="login-submit">
                <span class="login-submit-label">Entrar</span>
                <span class="login-spinner" aria-hidden="true"></span>
            </button>
        </form>

        <?php if ($needsSetup): ?>
        <p class="login-hint">
            Primera puesta en marcha: <b>admin</b> / <b>admin</b>.
            La aplicación pedirá cambiar el usuario y la contraseña.
        </p>
        <?php endif; ?>

        <p class="login-cookies">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-3.5 8-10V5l-8-3-8 3v7c0 6.5 8 10 8 10z"/><path d="m9 11 2.2 2.2L15.5 9"/></svg>
            <span>Esta web utiliza únicamente cookies técnicas necesarias para el inicio de sesión. No se emplean cookies de análisis, publicidad ni de terceros.</span>
        </p>
    </section>
</main>

<div class="app-signature" aria-label="Aplicación y versión">
    <span class="app-signature-title"><?= $e(Version::title($version)) ?></span>
    <?php if ($version['author'] !== ''): ?>
    <span class="app-signature-author"><?= $e($version['author']) ?></span>
    <?php endif; ?>
</div>

<script>
(() => {
    'use strict';
    const form = document.getElementById('login-form');
    const error = document.getElementById('login-error');
    const submit = document.getElementById('login-submit');
    const user = document.getElementById('login-user');
    const pass = document.getElementById('login-pass');

    const fail = (message) => {
        error.textContent = message;
        error.hidden = false;
    };

    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        error.hidden = true;
        const username = user.value.trim();
        const password = pass.value;
        if (!username || !password) {
            fail('Escribe el usuario y la contraseña.');
            return;
        }
        submit.disabled = true;
        submit.classList.add('is-loading');
        try {
            const res = await fetch('api.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ action: 'login', username, password }),
            });
            let data;
            try { data = await res.json(); } catch { throw new Error('respuesta no válida del servidor'); }
            if (!res.ok || !data.ok) throw new Error(data.error || 'No se pudo iniciar sesión.');
            location.replace('./');
        } catch (err) {
            fail(err.message || 'No se pudo iniciar sesión.');
            pass.value = '';
            pass.focus();
            submit.disabled = false;
            submit.classList.remove('is-loading');
        }
    });
})();
</script>
</body>
</html>
