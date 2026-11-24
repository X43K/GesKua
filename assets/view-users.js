/* ==========================================================================
   Vista: usuarios y permisos (gestión de superadministrador y desbloqueo de administradores).
   ========================================================================== */
(() => {
    'use strict';

    const { S, $, h, icon, fmtNum } = G;
    let users = null;

    // Orden habitual en desplegables, resúmenes y listados.
    const ROLE_LABELS = {
        admin: 'Superadministrador',
        editor: 'Administrador',
        colaborador: 'Colaborador',
        lector: 'Lector',
    };
    const roleLabel = (role) => ROLE_LABELS[role] || ROLE_LABELS.editor;
    const roleTag = (role) => {
        if (role === 'admin') return '<span class="tag ok">Superadministrador</span>';
        if (role === 'editor') return '<span class="tag line">Administrador</span>';
        if (role === 'colaborador') return '<span class="tag warn">Colaborador</span>';
        if (role === 'lector') return '<span class="tag">Lector</span>';
        return '<span class="tag line">Administrador</span>';
    };

    const fmtDate = (value) => {
        if (!value) return '—';
        const d = new Date(value);
        if (Number.isNaN(d.getTime())) return '—';
        return new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric' }).format(d);
    };

    const kpi = (name, iconName, value, label, sub) => `<div class="kpi">
        <div class="kpi-icon">${icon(iconName)}</div>
        <div class="kpi-body"><div class="kpi-value" data-kpi="${name}">${value}</div>
        <div class="kpi-label">${label}</div><div class="kpi-sub">${sub}</div></div>
    </div>`;

    function rows(list) {
        const me = G.user?.id;
        if (!list.length) {
            return `<tr><td colspan="5"><div class="empty">${icon('users')}<b>Sin usuarios</b><p>Crea la primera cuenta de acceso.</p></div></td></tr>`;
        }
        return list.map((u) => {
            const self = u.id === me;
            const meta = u.locked
                ? `Bloqueada${u.lockedAt ? ' el ' + h(fmtDate(u.lockedAt)) : ''}`
                : (u.mustChange ? 'Cambio inicial pendiente' : 'Cuenta activa');
            const actions = [];
            if (u.locked && G.canUnlockUsers) {
                actions.push(`<button type="button" class="btn btn-ghost btn-sm" data-unlock-user="${h(u.id)}" title="Desbloquear cuenta">${icon('key')} Desbloquear</button>`);
            }
            if (G.canManageUsers) {
                actions.push(`<button type="button" class="icon-btn" data-edit-user="${h(u.id)}" title="Editar">${icon('edit')}</button>`);
                if (!self) {
                    actions.push(`<button type="button" class="icon-btn" data-del-user="${h(u.id)}" title="Eliminar">${icon('trash')}</button>`);
                }
            }
            return `<tr data-user="${h(u.id)}">
                <td><div class="person"><span class="avatar ${u.role === 'admin' ? '' : 'alt'}">${h(String(u.username).slice(0, 2).toUpperCase())}</span>
                    <div style="min-width:0"><div class="person-name">${h(u.username)} ${self ? '<span class="tag info">Tú</span>' : ''}</div>
                    <div class="person-meta">${meta}</div></div></div></td>
                <td>${roleTag(u.role)}</td>
                <td>${u.locked ? '<span class="tag bad">Bloqueada</span>' : '<span class="tag ok">Activa</span>'}</td>
                <td class="num">${h(fmtDate(u.createdAt))}</td>
                <td class="actions">${actions.join('') || '<span class="tag line">Sin acciones</span>'}</td>
            </tr>`;
        }).join('');
    }

    function renderUsuarios() {
        const total = users?.length || 0;
        const admins = users?.filter((u) => u.role === 'admin').length || 0;
        const editors = users?.filter((u) => u.role === 'editor').length || 0;
        const collaborators = users?.filter((u) => u.role === 'colaborador').length || 0;
        const readers = users?.filter((u) => u.role === 'lector').length || 0;
        const locked = users?.filter((u) => !!u.locked).length || 0;

        return `
        <div class="page-head">
            <div><h2>Usuarios</h2><p>${G.canManageUsers
                ? 'Crea cuentas y decide quién puede administrar la aplicación.'
                : 'Consulta las cuentas y desbloquea las que estén bloqueadas.'}</p></div>
            <div class="spacer"></div>
            ${G.canManageUsers ? `<button type="button" class="btn btn-primary" data-new-user>${icon('plus')} Nuevo usuario</button>` : ''}
        </div>
        <div class="kpi-row">
            ${kpi('u-total', 'users', fmtNum(total), 'Usuarios', 'Con acceso a la aplicación')}
            ${kpi('u-locked', 'key', fmtNum(locked), 'Bloqueadas', 'Tras 3 intentos fallidos')}
            ${kpi('u-admin', 'shield', fmtNum(admins), 'Superadministradores', 'Acceso total, incluidos usuarios')}
            ${kpi('u-editor', 'edit', fmtNum(editors), 'Administradores', 'Gestionan datos y desbloquean cuentas')}
            ${kpi('u-colaborador', 'calendar', fmtNum(collaborators), 'Colaboradores', 'Preparan datos y generan cada mes')}
            ${kpi('u-lector', 'users', fmtNum(readers), 'Lectores', 'Solo consultan, no pueden editar')}
        </div>
        <section class="panel">
            <div class="panel-head">
                <div><h3>Cuentas de acceso</h3><p>${total} ${total === 1 ? 'usuario' : 'usuarios'} · ${admins} ${admins === 1 ? 'administrador' : 'administradores'}</p></div>
            </div>
            <div class="table-wrap"><table class="data">
                <thead><tr><th>Usuario</th><th>Rol</th><th>Estado</th><th class="num">Creado</th><th></th></tr></thead>
                <tbody id="users-body">${users ? rows(users) : `<tr><td colspan="5"><div class="empty">${icon('users')}<b>Cargando usuarios…</b></div></td></tr>`}</tbody>
            </table></div>
        </section>
        <section class="panel" style="margin-top:13px">
            <div class="panel-head"><div><h3>Roles y permisos</h3><p>Qué puede hacer cada tipo de cuenta</p></div></div>
            <div class="modal-body"><div class="role-info">
                <div><span class="tag ok">Superadministrador</span><p>Acceso completo: cuadrante, personal, flota, turnos, resumen, ajustes y gestión de usuarios. Puede crear, editar y eliminar cuentas.</p></div>
                <div><span class="tag line">Administrador</span><p>Acceso completo a cuadrante, personal, flota, turnos, resumen y ajustes. Ve Usuarios solo para desbloquear cuentas: no puede crear, editar ni eliminar usuarios. También puede cambiar su propia contraseña desde el menú de usuario.</p></div>
                <div><span class="tag warn">Colaborador</span><p>Puede preparar personal, flota, turnos y ausencias, y autoasignar el mes mientras no tenga turnos asignados. Ajustes es solo lectura: no puede cambiar reglas, festivos ni restaurar datos. Una vez generado ese cuadrante, no puede editarlo, limpiarlo ni autoasignarlo de nuevo. No ve la sección de usuarios. Puede cambiar a otro mes vacío.</p></div>
                <div><span class="tag">Lector</span><p>Solo consulta cuadrante, personal, flota, turnos, resumen y ajustes. No ve botones de edición ni de subida de Excel y no puede modificar datos; únicamente puede cambiar su propia contraseña desde el menú de usuario.</p></div>
            </div>
            <p class="field-hint" style="margin-top:10px">Una cuenta se bloquea automáticamente tras 3 intentos fallidos de contraseña. Un Superadministrador o un Administrador puede desbloquearla desde esta tabla; un Colaborador o un Lector no puede hacerlo.</p></div>
        </section>`;
    }

    async function loadUsers() {
        try {
            const res = await G.api('users');
            users = res.users || [];
        } catch (err) {
            users = [];
            G.toast('No se pudieron cargar los usuarios: ' + err.message, 'bad');
        }
    }

    function bindUsuarios() {
        const view = $('#view');
        view.onclick = (e) => {
            const unlock = e.target.closest('[data-unlock-user]');
            if (unlock) { unlockUser(unlock.dataset.unlockUser); return; }
            if (!G.canManageUsers) return;
            if (e.target.closest('[data-new-user]')) { openUserModal(null); return; }
            const edit = e.target.closest('[data-edit-user]');
            if (edit) { openUserModal(users?.find((u) => u.id === edit.dataset.editUser)); return; }
            const del = e.target.closest('[data-del-user]');
            if (del) { deleteUser(del.dataset.delUser); return; }
        };
        if (users !== null) return;
        loadUsers().then(() => {
            if (S.view === 'usuarios') G.render();
        });
    }

    function openUserModal(user) {
        const isNew = !user;
        const me = G.user;
        const isSelf = !!user && user.id === me?.id;
        const u = user || { id: '', username: '', role: 'editor' };
        const modal = G.openModal({
            title: isNew ? 'Nuevo usuario' : 'Editar usuario',
            subtitle: isNew ? 'Crea una cuenta de acceso a la aplicación' : roleLabel(u.role),
            body: `<div class="form-grid">
                <div class="field full"><label>Nombre de usuario <em>obligatorio</em></label>
                    <input id="usr-name" value="${h(u.username)}" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Por ejemplo: marta"></div>
                <div class="field full"><label>Rol</label>
                    <select id="usr-role" ${isSelf ? 'disabled' : ''}>
                        <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Superadministrador · acceso total y usuarios</option>
                        <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>Administrador · datos y desbloqueo de cuentas</option>
                        <option value="colaborador" ${u.role === 'colaborador' ? 'selected' : ''}>Colaborador · prepara datos y genera cada mes una vez</option>
                        <option value="lector" ${u.role === 'lector' ? 'selected' : ''}>Lector · solo consulta, sin edición</option>
                    </select>
                    ${isSelf ? '<span class="field-hint">Tu propio rol no se puede cambiar desde aquí.</span>' : ''}
                </div>
                <div class="field"><label>Contraseña ${isNew ? '<em>obligatoria</em>' : '<em>opcional</em>'}</label>
                    <input type="password" id="usr-pass" autocomplete="new-password" placeholder="${isNew ? 'Mínimo 6 caracteres' : 'Dejar en blanco para mantenerla'}"></div>
                <div class="field"><label>Repetir contraseña</label>
                    <input type="password" id="usr-repeat" autocomplete="new-password"></div>
            </div>
            ${isNew ? '<p class="field-hint" style="margin-top:9px">La cuenta podrá cambiar su contraseña desde el menú de usuario.</p>' : ''}`,
            footer: `<span class="spacer"></span>
                <button type="button" class="btn" data-cancel>Cancelar</button>
                <button type="button" class="btn btn-primary" data-save>${isNew ? 'Crear usuario' : 'Guardar cambios'}</button>`,
            onMount: (card, close) => {
                const save = card.querySelector('[data-save]');
                save.addEventListener('click', async () => {
                    const username = card.querySelector('#usr-name').value.trim();
                    const role = isSelf ? u.role : card.querySelector('#usr-role').value;
                    const password = card.querySelector('#usr-pass').value;
                    const repeat = card.querySelector('#usr-repeat').value;
                    if (!username) { G.toast('El nombre de usuario es obligatorio', 'bad'); return; }
                    if (isNew && password.length < 6) { G.toast('La contraseña debe tener al menos 6 caracteres', 'bad'); return; }
                    if (password && password.length < 6) { G.toast('La contraseña debe tener al menos 6 caracteres', 'bad'); return; }
                    if (password !== repeat) { G.toast('Las contraseñas no coinciden', 'bad'); return; }
                    save.disabled = true;
                    try {
                        const res = await G.api('saveUser', { user: { id: u.id, username, role, password } });
                        users = res.users || [];
                        if (res.user && res.user.id === G.user?.id) G.setUser(res.user);
                        close();
                        G.render();
                        G.toast(isNew ? 'Usuario creado' : 'Usuario actualizado');
                    } catch (err) {
                        G.toast('No se pudo guardar: ' + err.message, 'bad');
                    } finally {
                        save.disabled = false;
                    }
                });
                card.querySelector('[data-cancel]').addEventListener('click', close);
                card.querySelector('#usr-name').focus();
            },
        });
        void modal;
    }

    async function unlockUser(id) {
        const user = users?.find((u) => u.id === id);
        if (!user) return;
        const ok = await G.confirmDialog('Desbloquear cuenta',
            `Se reiniciarán los intentos fallidos de <b>${h(user.username)}</b> y podrá volver a iniciar sesión.`,
            { confirm: 'Desbloquear' });
        if (!ok) return;
        try {
            const res = await G.api('unlockUser', { id });
            users = res.users || [];
            if (res.user && res.user.id === G.user?.id) G.setUser(res.user);
            G.render();
            G.toast('Cuenta desbloqueada');
        } catch (err) {
            G.toast('No se pudo desbloquear: ' + err.message, 'bad');
        }
    }

    async function deleteUser(id) {
        const user = users?.find((u) => u.id === id);
        if (!user) return;
        const ok = await G.confirmDialog('Eliminar usuario',
            `Se eliminará la cuenta <b>${h(user.username)}</b>. La persona ya no podrá acceder a la aplicación. Esta acción no se puede deshacer.`,
            { confirm: 'Eliminar', danger: true });
        if (!ok) return;
        try {
            const res = await G.api('deleteUser', { id });
            users = res.users || [];
            G.render();
            G.toast('Usuario eliminado');
        } catch (err) {
            G.toast('No se pudo eliminar: ' + err.message, 'bad');
        }
    }

    G.views.usuarios = renderUsuarios;
    G.binders.usuarios = bindUsuarios;
})();
