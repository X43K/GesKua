/* ==========================================================================
   Autenticación: menú de usuario, perfil y cambio inicial de credenciales.
   ========================================================================== */
(() => {
    'use strict';

    const { S, $, $$, h } = G;
    let user = window.GESTION?.user || null;
    let forcing = false;

    const ROLE_LABELS = {
        admin: 'Superadministrador',
        editor: 'Administrador',
        colaborador: 'Colaborador',
        lector: 'Lector',
    };
    const roleLabel = (role) => ROLE_LABELS[role] || ROLE_LABELS.editor;

    /* El mes asignado bloquea al colaborador. Esta comprobación se hace en vivo
       porque el mes puede cambiar, autoasignarse o pintarse sin recargar. */
    const lockedForCollaborator = () => !!user
        && user.role === 'colaborador'
        && !!G.S.db
        && typeof G.monthHasAssignments === 'function'
        && G.monthHasAssignments(G.S.month);

    function updatePermissions() {
        G.isAdmin = user?.role === 'admin';
        G.isEditor = user?.role === 'editor';
        G.canImportSchedule = !!user && (G.isAdmin === true || G.isEditor === true);
        G.isReader = user?.role === 'lector';
        G.isColaborador = user?.role === 'colaborador';
        // Gestión completa solo para superadministrador; desbloqueo también
        // para administrador. Estos getters se usan al dibujar Usuarios.
        G.canManageUsers = !!user && (G.isAdmin === true);
        G.canUnlockUsers = !!user && (G.isAdmin === true || G.isEditor === true);
        document.body.classList.toggle('role-lector', !!G.isReader);
        document.body.classList.toggle('role-collaborator', !!G.isColaborador);
        document.body.classList.toggle('role-locked', lockedForCollaborator());
        updateChip();
    }

    const initialsOf = (name) => {
        const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
        if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
        return String(name || '?').slice(0, 2).toUpperCase();
    };

    function updateChip() {
        if (!user) return;
        const initials = $('#user-initials');
        if (initials) initials.textContent = initialsOf(user.username);
        const name = $('#user-name');
        if (name) name.textContent = user.username;
        const role = $('#user-role');
        if (role) role.textContent = roleLabel(user.role);
        const dropName = $('#user-dropdown-name');
        if (dropName) dropName.textContent = user.username;
        const dropRole = $('#user-dropdown-role');
        if (dropRole) dropRole.textContent = roleLabel(user.role);
    }

    function setUser(next) {
        user = next;
        window.GESTION.user = next;
        G.user = next;
        updatePermissions();
    }

    function setMenu(open) {
        const menu = $('#user-menu');
        const dropdown = $('#user-dropdown');
        const chip = $('#user-chip');
        if (!menu || !dropdown || !chip) return;
        dropdown.hidden = !open;
        chip.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    function bindMenu() {
        const chip = $('#user-chip');
        if (!chip) return;
        chip.addEventListener('click', (e) => {
            e.stopPropagation();
            setMenu($('#user-dropdown').hidden);
        });
        document.addEventListener('click', (e) => {
            const menu = $('#user-menu');
            if (menu && !menu.contains(e.target)) setMenu(false);
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') setMenu(false);
        });
        $('[data-profile]')?.addEventListener('click', () => {
            setMenu(false);
            openProfile();
        });
        $('[data-logout]')?.addEventListener('click', () => {
            setMenu(false);
            logout();
        });
        updateChip();
    }

    /* ---------- Cambio de contraseña desde el perfil ---------------------- */

    function openProfile() {
        if (!user) return;
        const modal = G.openModal({
            title: 'Cambiar contraseña',
            subtitle: `Cuenta ${user.username} · ${roleLabel(user.role)}`,
            body: `<div class="form-grid">
                <div class="field full"><label>Contraseña actual</label><input type="password" id="pf-current" autocomplete="current-password"></div>
                <div class="field"><label>Nueva contraseña <em>mínimo 6</em></label><input type="password" id="pf-new" autocomplete="new-password"></div>
                <div class="field"><label>Repetir contraseña</label><input type="password" id="pf-repeat" autocomplete="new-password"></div>
            </div>
            <p class="field-hint" style="margin-top:9px">El nombre de usuario no cambia desde aquí.</p>`,
            footer: `<span class="spacer"></span>
                <button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>Guardar contraseña</button>`,
            onMount: (card, close) => {
                const save = card.querySelector('[data-save]');
                save.addEventListener('click', async () => {
                    const currentPassword = card.querySelector('#pf-current').value;
                    const password = card.querySelector('#pf-new').value;
                    const repeat = card.querySelector('#pf-repeat').value;
                    if (!currentPassword) { G.toast('Escribe tu contraseña actual', 'bad'); return; }
                    if (password.length < 6) { G.toast('La nueva contraseña debe tener al menos 6 caracteres', 'bad'); return; }
                    if (password !== repeat) { G.toast('Las contraseñas nuevas no coinciden', 'bad'); return; }
                    save.disabled = true;
                    try {
                        const res = await G.api('changeCredentials', { currentPassword, username: '', password });
                        setUser(res.user);
                        close();
                        G.toast('Contraseña actualizada');
                    } catch (err) {
                        G.toast('No se pudo cambiar: ' + err.message, 'bad');
                    } finally {
                        save.disabled = false;
                    }
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
                card.querySelector('#pf-current').focus();
            },
        });
        void modal;
    }

    /* ---------- Cambio obligatorio de las credenciales iniciales ---------- */

    function openForcedSetup() {
        if (forcing || !user || !user.mustChange) return;
        forcing = true;
        const modal = G.openModal({
            title: 'Configura tu cuenta',
            subtitle: 'Antes de empezar debes sustituir las credenciales iniciales.',
            dismissible: false,
            body: `<div class="auth-note">
                    <b>Estás usando la cuenta inicial admin/admin.</b>
                    <span>Por seguridad, elige un nombre de usuario y una contraseña propios. No podrás usar la aplicación hasta guardarlos.</span>
                </div>
                <div class="form-grid">
                    <div class="field full"><label>Contraseña actual</label><input type="password" id="setup-current" autocomplete="current-password" placeholder="admin"></div>
                    <div class="field full"><label>Nuevo usuario <em>obligatorio</em></label><input type="text" id="setup-user" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Por ejemplo: javier"></div>
                    <div class="field"><label>Nueva contraseña <em>mínimo 6</em></label><input type="password" id="setup-pass" autocomplete="new-password"></div>
                    <div class="field"><label>Repetir contraseña</label><input type="password" id="setup-repeat" autocomplete="new-password"></div>
                </div>`,
            footer: `<span class="spacer"></span>
                <button type="button" class="btn btn-primary" data-save>Guardar y continuar</button>`,
            onMount: (card, close) => {
                const save = card.querySelector('[data-save]');
                const finish = () => {
                    forcing = false;
                    close();
                };
                save.addEventListener('click', async () => {
                    const currentPassword = card.querySelector('#setup-current').value;
                    const username = card.querySelector('#setup-user').value.trim();
                    const password = card.querySelector('#setup-pass').value;
                    const repeat = card.querySelector('#setup-repeat').value;
                    if (!currentPassword) { G.toast('Escribe la contraseña actual (admin)', 'bad'); return; }
                    if (!username) { G.toast('Elige un nombre de usuario', 'bad'); return; }
                    if (username.toLowerCase() === 'admin') { G.toast('El nuevo usuario no puede ser «admin»', 'bad'); return; }
                    if (password.length < 6) { G.toast('La nueva contraseña debe tener al menos 6 caracteres', 'bad'); return; }
                    if (password !== repeat) { G.toast('Las contraseñas nuevas no coinciden', 'bad'); return; }
                    save.disabled = true;
                    try {
                        const res = await G.api('changeCredentials', { currentPassword, username, password });
                        setUser(res.user);
                        G.toast('Credenciales actualizadas');
                        finish();
                    } catch (err) {
                        G.toast(err.message, 'bad');
                    } finally {
                        save.disabled = false;
                    }
                });
                card.querySelector('#setup-current').focus();
            },
            onClose: () => {
                // Solo se cierra tras guardar; si algo lo forzara, se reabre.
                if (user?.mustChange) {
                    forcing = false;
                    setTimeout(openForcedSetup, 30);
                }
            },
        });
        void modal;
    }

    /* ---------- Cierre de sesión ------------------------------------------ */

    async function logout() {
        try {
            if (S.pending.size) await G.flushPending();
        } catch { /* se cierra igualmente */ }
        S.pending.clear();
        try {
            await fetch('api.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ action: 'logout' }),
            });
        } catch { /* la redirección limpia la sesión local */ }
        location.replace('login.php');
    }

    G.user = user;
    Object.defineProperty(G, 'canEdit', {
        configurable: true,
        get: () => !!user && !G.isReader && !lockedForCollaborator(),
    });
    // Ajustes es consulta para lectores y colaboradores; a estos últimos no se
    // les permite tocar reglas, festivos ni restauraciones aunque el mes esté vacío.
    Object.defineProperty(G, 'canEditSettings', {
        configurable: true,
        get: () => !!user && !G.isReader && !G.isColaborador,
    });
    updatePermissions();
    G.updatePermissions = updatePermissions;
    G.openProfile = openProfile;
    G.openForcedSetup = openForcedSetup;
    G.logout = logout;
    G.updateUserChip = updateChip;
    G.setUser = setUser;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindMenu);
    else bindMenu();
})();
