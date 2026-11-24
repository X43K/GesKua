<?php
declare(strict_types=1);

ob_start();

require_once __DIR__ . '/lib/Compat.php';
require_once __DIR__ . '/lib/Store.php';
require_once __DIR__ . '/lib/Auth.php';

@ini_set('display_errors', '0');
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

function respond(array $payload, int $status = 200): never
{
    while (ob_get_level() > 0) {
        ob_end_clean();
    }
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return $_POST;
    }
    $data = json_decode($raw, true);
    return is_array($data) ? $data : $_POST;
}

function clean(mixed $v, int $max = 500): string
{
    $s = trim((string)$v);
    if (mb_strlen($s, 'UTF-8') > $max) {
        $s = mb_substr($s, 0, $max, 'UTF-8');
    }
    return $s;
}

function monthOk(string $m): bool
{
    return (bool)preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $m);
}

/**
 * El mes activo es una preferencia de la sesión: al entrar o al salir vuelve
 * al mes real. Mientras la sesión sigue abierta se conserva lo que el usuario
 * haya elegido en el selector superior.
 */
function resetSessionMonth(Store $store): void
{
    $db = $store->load();
    $month = date('Y-m');
    if (($db['settings']['currentMonth'] ?? '') === $month) {
        return;
    }
    $db['settings']['currentMonth'] = $month;
    $store->write($db);
}

function dateOk(string $d): bool
{
    return (bool)preg_match('/^\d{4}-\d{2}-\d{2}$/', $d) && strtotime($d) !== false;
}

/** Acepta solo imágenes incrustadas y limita el tamaño para no inflar db.json. */
function photoOk(mixed $v): string
{
    $s = (string)$v;
    if ($s === '') {
        return '';
    }
    if (!preg_match('/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+\/=\s]+)$/', $s, $m)) {
        return '';
    }
    $raw = base64_decode(preg_replace('/\s+/', '', $m[2]), true);
    if ($raw === false || strlen($raw) > 900000) {
        return '';
    }
    return 'data:image/' . $m[1] . ';base64,' . preg_replace('/\s+/', '', $m[2]);
}

/** Quita de las fichas los combustibles que ya no existen en el catálogo. */
function pruneDriverFuelAuthorizations(array &$db): void
{
    $fuels = Store::vehicleFuels($db);
    foreach ($db['drivers'] as &$driver) {
        $driver['authorizedFuels'] = array_values(array_filter(
            (array)($driver['authorizedFuels'] ?? []),
            static fn($f) => in_array((string)$f, $fuels, true)
        ));
    }
    unset($driver);
}

/** Quita de las líneas los combustibles que ya no están en el catálogo. */
function pruneLineRestrictions(array &$db): void
{
    $fuels = Store::vehicleFuels($db);
    foreach ($db['lines'] as &$line) {
        $line['fuelValues'] = array_values(array_filter(
            (array)($line['fuelValues'] ?? []),
            static fn($f) => in_array((string)$f, $fuels, true)
        ));
        if (($line['fuelMode'] ?? 'all') !== 'all' && empty($line['fuelValues'])) {
            $line['fuelMode'] = 'all';
        }
        // Los tamaños se dejan intactos: se pueden fijar topes aunque todavía
        // no exista una variante con esa medida exacta.
    }
    unset($line);
}

function findIndex(array $rows, callable $fn): ?int
{
    foreach ($rows as $i => $row) {
        if ($fn($row)) {
            return (int)$i;
        }
    }
    return null;
}

try {
    $store = new Store(__DIR__ . '/data');
    $auth = new Auth(__DIR__ . '/data');
    Auth::boot();
    $action = (string)($_GET['action'] ?? '');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $input = $method === 'POST' ? body() : [];
    if (isset($input['action'])) {
        $action = (string)$input['action'];
    }

    $public = ['login', 'session'];
    $user = $auth->currentUser();

    if ($action === 'login') {
        if ($method !== 'POST') {
            respond(['ok' => false, 'error' => 'Método no permitido.'], 405);
        }
        $username = clean($input['username'] ?? '', 80);
        $password = (string)($input['password'] ?? '');
        $logged = $auth->login($username, $password);
        if (!$logged) {
            if ($auth->loginStatus() === 'locked') {
                respond([
                    'ok' => false,
                    'error' => 'Cuenta bloqueada tras 3 intentos fallidos. Contacta con un administrador para desbloquearla.',
                    'locked' => true,
                ], 423);
            }
            respond(['ok' => false, 'error' => 'Usuario o contraseña incorrectos.'], 401);
        }
        // Cada acceso arranca en el mes actual, aunque otro usuario hubiera
        // dejado seleccionado otro mes en su sesión.
        resetSessionMonth($store);
        respond(['ok' => true, 'user' => $logged]);
    }

    if ($action === 'session') {
        respond(['ok' => true, 'user' => $user]);
    }

    if (!$user) {
        respond(['ok' => false, 'error' => 'Sesión no iniciada.', 'auth' => false], 401);
    }

    // Mientras no se cambien las credenciales iniciales solo se permite lo
    // imprescindible para completar ese cambio o cerrar la sesión.
    if (!empty($user['mustChange']) && !in_array($action, ['bootstrap', 'logout', 'changeCredentials'], true)) {
        respond(['ok' => false, 'error' => 'Debes cambiar las credenciales iniciales.', 'mustChange' => true], 403);
    }

    $role = (string)($user['role'] ?? '');
    $canUnlockUsers = in_array($role, ['admin', 'editor'], true);

    // Administradores y superadministradores pueden consultar Usuarios para
    // desbloquear cuentas. Solo el superadministrador gestiona altas, cambios
    // y bajas; el administrador no puede crear, editar ni eliminar usuarios.
    if ($action === 'users' && !$canUnlockUsers) {
        respond(['ok' => false, 'error' => 'Tu cuenta no puede consultar los usuarios.'], 403);
    }
    if ($action === 'unlockUser' && !$canUnlockUsers) {
        respond(['ok' => false, 'error' => 'Tu cuenta no puede desbloquear usuarios.'], 403);
    }
    // La importación del cuadrante en Excel queda reservada a administradores.
    if ($action === 'importSchedule' && !$canUnlockUsers) {
        respond(['ok' => false, 'error' => 'Solo los administradores pueden importar el cuadrante.'], 403);
    }
    if (in_array($action, ['saveUser', 'deleteUser'], true) && $role !== 'admin') {
        respond(['ok' => false, 'error' => 'Solo los superadministradores pueden gestionar usuarios.'], 403);
    }

    // El rol lector solo consulta: se bloquean las escrituras incluso si se
    // llaman directamente a la API, no solo desde los botones de la interfaz.
    $lectorAllowed = ['bootstrap', 'logout', 'changeCredentials', 'session'];
    if ((string)($user['role'] ?? '') === 'lector' && !in_array($action, $lectorAllowed, true)) {
        respond(['ok' => false, 'error' => 'Tu cuenta es de solo lectura; no puede modificar datos.'], 403);
    }

    // El colaborador puede preparar los datos y generar cada mes una sola vez.
    // En cuanto ese mes tiene turnos asignados queda bloqueado también por API:
    // no puede editar, limpiar ni volver a autoasignarlo. Ajustes es siempre de
    // solo lectura para este rol, incluso en un mes todavía sin asignar.
    if ((string)($user['role'] ?? '') === 'colaborador') {
        $collaboratorAllowed = ['bootstrap', 'logout', 'changeCredentials', 'session', 'setCurrentMonth'];
        $collaboratorSettingsDenied = ['saveSettings', 'saveHolidays', 'saveNeeds', 'reset'];
        if (in_array($action, $collaboratorSettingsDenied, true)) {
            respond(['ok' => false, 'error' => 'Tu cuenta solo puede consultar los ajustes; no puede modificarlos.'], 403);
        }
        if (!in_array($action, $collaboratorAllowed, true)) {
            $db = $store->load();
            // Las acciones sobre el cuadrante siempre llevan el mes; las demás
            // (personal, flota, turnos, ausencias) usan el mes activo guardado.
            if (in_array($action, ['saveAssignments', 'autoAssign'], true)) {
                $month = clean($input['month'] ?? '', 7);
            } else {
                // El cliente colaborador envía siempre el mes que está viendo;
                // si no llega, se usa el guardado como alternativa segura.
                $month = clean($input['month'] ?? '', 7);
                if (!monthOk($month)) {
                    $month = clean($db['settings']['currentMonth'] ?? '', 7);
                }
                if (!monthOk($month)) {
                    respond(['ok' => false, 'error' => 'No se pudo determinar el mes activo.'], 400);
                }
            }
            if (!monthOk($month)) {
                respond(['ok' => false, 'error' => 'Mes no válido.'], 400);
            }
            if (Store::monthHasAssignments($db, $month)) {
                respond(['ok' => false, 'error' => 'El cuadrante de este mes ya está asignado; no puedes modificarlo.'], 403);
            }
        }
    }

    if ($action === 'bootstrap') {
        $db = $store->load();
        respond([
            'ok' => true,
            'db' => $db,
            'user' => $user,
            'serverTime' => date('c'),
            'seedFile' => 'data/seed.json',
        ]);
    }

    if ($method !== 'POST') {
        respond(['ok' => false, 'error' => 'Método no permitido.'], 405);
    }

    switch ($action) {
        case 'logout': {
            $auth->logout();
            resetSessionMonth($store);
            respond(['ok' => true]);
        }

        case 'changeCredentials': {
            $updated = $auth->changeCredentials(
                (string)$user['id'],
                (string)($input['currentPassword'] ?? ''),
                (string)($input['username'] ?? ''),
                (string)($input['password'] ?? '')
            );
            respond(['ok' => true, 'user' => $updated]);
        }

        case 'users': {
            respond(['ok' => true, 'users' => $auth->listUsers()]);
        }

        case 'unlockUser': {
            $unlocked = $auth->unlockUser(clean($input['id'] ?? '', 40), (string)$user['id']);
            respond(['ok' => true, 'user' => $unlocked, 'users' => $auth->listUsers()]);
        }

        case 'saveUser': {
            $data = $input['user'] ?? null;
            if (!is_array($data)) {
                respond(['ok' => false, 'error' => 'Usuario no válido.'], 400);
            }
            $saved = $auth->saveUser($data, (string)$user['id']);
            respond(['ok' => true, 'user' => $saved, 'users' => $auth->listUsers()]);
        }

        case 'deleteUser': {
            $auth->deleteUser(clean($input['id'] ?? '', 40), (string)$user['id']);
            respond(['ok' => true, 'users' => $auth->listUsers()]);
        }

        case 'importSchedule': {
            $month = clean($input['month'] ?? '', 7);
            $changes = $input['changes'] ?? null;
            if (!monthOk($month) || !is_array($changes)) {
                respond(['ok' => false, 'error' => 'Petición no válida.'], 400);
            }
            if (count($changes) > 20000) {
                respond(['ok' => false, 'error' => 'Demasiados cambios en una sola petición.'], 400);
            }
            $db = $store->load();
            $result = Store::resolveAssignmentChanges($db, $month, $changes);
            $db['assignments'][$month] = $result['assignments'];
            $db['vehicleAssignments'][$month] = $result['vehicleAssignments'];
            $store->write($db);
            respond([
                'ok' => true,
                'saved' => $result['saved'],
                'rejected' => $result['rejected'],
                'reassigned' => $result['reassigned'],
                'db' => $db,
            ]);
        }

        case 'saveAssignments': {
            $month = clean($input['month'] ?? '', 7);
            $changes = $input['changes'] ?? null;
            if (!monthOk($month) || !is_array($changes)) {
                respond(['ok' => false, 'error' => 'Petición no válida.'], 400);
            }
            if (count($changes) > 20000) {
                respond(['ok' => false, 'error' => 'Demasiados cambios en una sola petición.'], 400);
            }
            $db = $store->load();
            $result = Store::resolveAssignmentChanges($db, $month, $changes);
            $db['assignments'][$month] = $result['assignments'];
            $db['vehicleAssignments'][$month] = $result['vehicleAssignments'];
            $store->write($db);
            respond([
                'ok' => true,
                'saved' => $result['saved'],
                'rejected' => $result['rejected'],
                'reassigned' => $result['reassigned'],
                'vehicleAssignments' => $result['vehicleAssignments'],
            ]);
        }

        case 'importCsv': {
            $kind = clean($input['kind'] ?? '', 20);
            $rows = $input['rows'] ?? null;
            if (!in_array($kind, ['drivers', 'vehicles', 'shifts'], true) || !is_array($rows) || count($rows) > 20000) {
                respond(['ok' => false, 'error' => 'El CSV no es válido o tiene demasiadas filas.'], 400);
            }
            $db = $store->load();
            $result = Store::applyCsvImport($db, $kind, array_values($rows), date('Y-m-d'));
            $db = $result['db'];
            $store->write($db);
            respond(['ok' => true, 'db' => $db, 'result' => $result['stats']]);
        }

        case 'saveDriver': {
            $data = $input['driver'] ?? null;
            if (!is_array($data)) {
                respond(['ok' => false, 'error' => 'Conductor no válido.'], 400);
            }
            $db = $store->load();
            $original = clean($input['originalId'] ?? '', 32);
            $catalogFuels = Store::vehicleFuels($db);
            $authorizedFuels = [];
            foreach ((array)($data['authorizedFuels'] ?? []) as $fuel) {
                $fuel = clean($fuel, 30);
                if ($fuel !== '' && in_array($fuel, $catalogFuels, true) && !in_array($fuel, $authorizedFuels, true)) {
                    $authorizedFuels[] = $fuel;
                }
            }
            $driver = [
                'id' => clean($data['id'] ?? '', 32),
                'name' => clean($data['name'] ?? '', 120),
                'firstName' => clean($data['firstName'] ?? '', 60),
                'lastName' => clean($data['lastName'] ?? '', 80),
                'role' => clean($data['role'] ?? 'Conductor', 40) ?: 'Conductor',
                'active' => (bool)($data['active'] ?? true),
                'phone' => clean($data['phone'] ?? '', 40),
                'license' => clean($data['license'] ?? '', 20),
                'since' => clean($data['since'] ?? '', 10),
                'notes' => clean($data['notes'] ?? '', 500),
                'authorizedFuels' => $authorizedFuels,
                'maxVehicleSize' => max(0, min(100, (int)($data['maxVehicleSize'] ?? 0))),
                'allowsArticulated' => !empty($data['allowsArticulated']),
                'group' => strtoupper(trim((string)($data['group'] ?? ''))),
                'partnerId' => clean($data['partnerId'] ?? '', 32),
            ];
            if ($driver['id'] === '' || $driver['name'] === '') {
                respond(['ok' => false, 'error' => 'El IDC y el nombre son obligatorios.'], 400);
            }
            $idx = findIndex($db['drivers'], static fn($d) => (string)$d['id'] === $original && $original !== '');
            $existing = $idx === null ? [] : $db['drivers'][$idx];
            foreach (['inactiveFrom' => '', 'deepInactive' => false, 'lastSeen' => '', 'partnerPendingId' => '', 'partnerBrokenAt' => ''] as $field => $default) {
                $driver[$field] = $existing[$field] ?? $default;
            }
            if (array_key_exists('partnerId', $data) && $driver['partnerId'] !== ''
                && $driver['partnerId'] !== (string)($existing['partnerPendingId'] ?? '')) {
                $driver['partnerPendingId'] = '';
                $driver['partnerBrokenAt'] = '';
            }
            $driver['inactiveFrom'] = $driver['active'] ? '' : ($driver['inactiveFrom'] !== '' ? $driver['inactiveFrom'] : date('Y-m-d'));
            if (!array_key_exists('group', $data)) {
                $driver['group'] = (string)($existing['group'] ?? '');
            }
            if (!array_key_exists('partnerId', $data)) {
                $driver['partnerId'] = (string)($existing['partnerId'] ?? '');
            }
            if ($idx !== null && $driver['id'] !== $original) {
                // Renombrado: actualiza también las asignaciones.
                foreach ($db['assignments'] as $month => $rows) {
                    $newRows = [];
                    foreach ($rows as $k => $v) {
                        [$did, $date] = array_pad(explode('|', (string)$k, 2), 2, '');
                        $newRows[($did === $original ? $driver['id'] : $did) . '|' . $date] = $v;
                    }
                    $db['assignments'][$month] = $newRows;
                }
                foreach ($db['absences'] as &$a) {
                    if ((string)($a['driverId'] ?? '') === $original) {
                        $a['driverId'] = $driver['id'];
                    }
                }
                unset($a);
                foreach ($db['drivers'] as &$other) {
                    if ((string)($other['partnerId'] ?? '') === $original) {
                        $other['partnerId'] = $driver['id'];
                    }
                }
                unset($other);
            }
            if ($idx === null) {
                $db['drivers'][] = $driver;
            } else {
                $db['drivers'][$idx] = $driver;
            }
            $db = Store::setDriverPairing($db, $driver['id'], $driver['group'], $driver['partnerId']);
            Store::normalisePairings($db);
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveDriverPairing': {
            $driverId = clean($input['driverId'] ?? '', 32);
            $group = strtoupper(trim((string)($input['group'] ?? '')));
            $partnerId = clean($input['partnerId'] ?? '', 32);
            $db = $store->load();
            $exists = false;
            $partnerExists = $partnerId === '';
            foreach ($db['drivers'] as $candidate) {
                $candidateId = (string)($candidate['id'] ?? '');
                if ($candidateId === $driverId) {
                    $exists = true;
                }
                if ($candidateId === $partnerId && $partnerId !== $driverId) {
                    $partnerExists = true;
                }
            }
            if (!$exists) {
                respond(['ok' => false, 'error' => 'Conductor no encontrado.'], 404);
            }
            if (!$partnerExists) {
                respond(['ok' => false, 'error' => 'El compañero indicado no es válido.'], 400);
            }
            foreach ($db['drivers'] as &$driver) {
                if ((string)($driver['id'] ?? '') === $driverId) {
                    $driver['partnerPendingId'] = '';
                    $driver['partnerBrokenAt'] = '';
                }
            }
            unset($driver);
            $db = Store::setDriverPairing($db, $driverId, $group, $partnerId);
            Store::normalisePairings($db);
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'deleteDriver': {
            $id = clean($input['id'] ?? '', 32);
            $db = $store->load();
            Store::breakPairingsFor($db, $id, date('Y-m-d'));
            $db['drivers'] = array_values(array_filter($db['drivers'], static fn($d) => (string)$d['id'] !== $id));
            $db['absences'] = array_values(array_filter($db['absences'], static fn($a) => (string)$a['driverId'] !== $id));
            foreach ($db['assignments'] as $month => $rows) {
                foreach (array_keys($rows) as $k) {
                    if (str_starts_with((string)$k, $id . '|')) {
                        unset($rows[$k]);
                    }
                }
                $db['assignments'][$month] = $rows;
            }
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveVehicle': {
            $data = $input['vehicle'] ?? null;
            if (!is_array($data)) {
                respond(['ok' => false, 'error' => 'Vehículo no válido.'], 400);
            }
            $db = $store->load();
            $original = clean($input['originalId'] ?? '', 32);

            $typeId = clean($data['typeId'] ?? '', 40);
            if ($typeId !== '' && !Store::findVehicleSubtype($db, $typeId)) {
                $typeId = '';
            }
            $model = clean($data['model'] ?? '', 80);
            $kind = clean($data['kind'] ?? 'urbano', 30);
            if ($typeId !== '') {
                $type = Store::findVehicleTypeOfSubtype($db, $typeId);
                $variant = Store::findVehicleSubtype($db, $typeId);
                if ($type) {
                    $model = trim((string)($type['brand'] ?? '') . ' ' . (string)($type['model'] ?? ''));
                }
                $size = strtolower((string)($variant['size'] ?? ''));
                if (str_contains($size, 'micro')) {
                    $kind = 'microbús';
                } elseif (preg_match('/(18|20|24)\s*m/', $size)) {
                    $kind = 'articulado';
                } else {
                    $kind = 'urbano';
                }
            }

            $vehicle = [
                'id' => clean($data['id'] ?? '', 32),
                'plate' => clean($data['plate'] ?? '', 20),
                'model' => $model,
                'kind' => $kind,
                'typeId' => $typeId,
                'photo' => photoOk($data['photo'] ?? ''),
                'status' => in_array($data['status'] ?? 'disponible', ['disponible', 'taller', 'reserva'], true) ? $data['status'] : 'disponible',
                'km' => max(0, (int)($data['km'] ?? 0)),
                'since' => clean($data['since'] ?? '', 10),
                'notes' => clean($data['notes'] ?? '', 500),
            ];
            if ($vehicle['id'] === '') {
                respond(['ok' => false, 'error' => 'El número de bus es obligatorio.'], 400);
            }
            $idx = findIndex($db['vehicles'], static fn($v) => (string)$v['id'] === $original && $original !== '');
            $existing = $idx === null ? [] : $db['vehicles'][$idx];
            foreach (['active' => true, 'inactiveFrom' => '', 'deepInactive' => false, 'lastSeen' => ''] as $field => $default) {
                $vehicle[$field] = $existing[$field] ?? $default;
            }
            if ($idx === null) {
                $db['vehicles'][] = $vehicle;
            } else {
                $db['vehicles'][$idx] = $vehicle;
            }
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'deleteVehicle': {
            $id = clean($input['id'] ?? '', 32);
            $db = $store->load();
            $db['vehicles'] = array_values(array_filter($db['vehicles'], static fn($v) => (string)$v['id'] !== $id));
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveLine': {
            $code = strtoupper(preg_replace('/\s+/', '', clean($input['code'] ?? '', 20)));
            $data = $input['line'] ?? null;
            if ($code === '' || !is_array($data)) {
                respond(['ok' => false, 'error' => 'Línea no válida.'], 400);
            }
            $db = $store->load();
            $idx = findIndex($db['lines'], static fn($l) => (string)($l['code'] ?? '') === $code);
            if ($idx === null) {
                // Alta de línea: el código debe ser algo como L20, C12 o P5.
                if (!preg_match('/^[A-Z][A-Z0-9]*$/', $code)) {
                    respond(['ok' => false, 'error' => 'Código de línea no válido.'], 400);
                }
                $num = (string)preg_replace('/^[A-Z]+/', '', $code);
                $prefix = $code[0];
                $defaultName = $prefix === 'C' ? 'Circular ' . $num
                    : ($prefix === 'P' ? 'Periférica ' . $num : 'Línea ' . $num);
                $db['lines'][] = [
                    'code' => $code,
                    'name' => $defaultName,
                    'color' => '#64748b',
                    'fuelMode' => 'all',
                    'fuelValues' => [],
                    'sizeMode' => 'all',
                    'sizeValues' => [],
                    'maxSize' => 0,
                ];
                $idx = count($db['lines']) - 1;
            }
            $catalogFuels = Store::vehicleFuels($db);
            $fuelMode = (string)($data['fuelMode'] ?? 'all');
            if (!in_array($fuelMode, ['all', 'only', 'deny'], true)) {
                $fuelMode = 'all';
            }
            $fuelValues = [];
            foreach ((array)($data['fuelValues'] ?? []) as $fuel) {
                $fuel = clean($fuel, 30);
                if ($fuel !== '' && in_array($fuel, $catalogFuels, true) && !in_array($fuel, $fuelValues, true)) {
                    $fuelValues[] = $fuel;
                }
            }
            if ($fuelMode !== 'all' && !$fuelValues) {
                $fuelMode = 'all';
            }
            $sizeMode = (string)($data['sizeMode'] ?? 'all');
            if (!in_array($sizeMode, ['all', 'only', 'max'], true)) {
                $sizeMode = 'all';
            }
            $sizeValues = [];
            foreach ((array)($data['sizeValues'] ?? []) as $n) {
                $n = (int)$n;
                if ($n > 0 && $n <= 100 && !in_array($n, $sizeValues, true)) {
                    $sizeValues[] = $n;
                }
            }
            if ($sizeMode === 'only' && !$sizeValues) {
                $sizeMode = 'all';
            }
            $maxSize = max(0, min(100, (int)($data['maxSize'] ?? 0)));
            if ($sizeMode === 'max' && $maxSize === 0) {
                $sizeMode = 'all';
            }
            $color = clean($data['color'] ?? $db['lines'][$idx]['color'] ?? '#64748b', 20);
            if (!preg_match('/^#[0-9a-fA-F]{6}$/', $color)) {
                $color = '#64748b';
            }
            $db['lines'][$idx]['name'] = clean($data['name'] ?? $db['lines'][$idx]['name'] ?? '', 80);
            $db['lines'][$idx]['color'] = $color;
            $db['lines'][$idx]['fuelMode'] = $fuelMode;
            $db['lines'][$idx]['fuelValues'] = $fuelValues;
            $db['lines'][$idx]['sizeMode'] = $sizeMode;
            $db['lines'][$idx]['sizeValues'] = $sizeValues;
            $db['lines'][$idx]['maxSize'] = $maxSize;
            $store->write($db);
            respond(['ok' => true, 'line' => $db['lines'][$idx], 'db' => $db]);
        }

        case 'deleteLine': {
            $code = strtoupper(preg_replace('/\s+/', '', clean($input['code'] ?? '', 20)));
            $db = $store->load();
            $idx = findIndex($db['lines'], static fn($l) => (string)($l['code'] ?? '') === $code);
            if ($idx === null) {
                respond(['ok' => false, 'error' => 'La línea ya no existe.'], 404);
            }
            // No se puede borrar una línea que todavía usan turnos o variantes.
            foreach ($db['shifts'] as $shift) {
                if ((string)($shift['line'] ?? '') === $code) {
                    respond(['ok' => false, 'error' => 'No se puede eliminar: hay turnos que usan esta línea.'], 400);
                }
                foreach (['lv', 'sab', 'dom'] as $kind) {
                    $variant = $shift['variants'][$kind] ?? null;
                    if (is_array($variant) && (string)($variant['line'] ?? '') === $code) {
                        respond(['ok' => false, 'error' => 'No se puede eliminar: hay turnos que usan esta línea.'], 400);
                    }
                }
            }
            array_splice($db['lines'], $idx, 1);
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveVehicleType': {
            $data = $input['type'] ?? null;
            if (!is_array($data)) {
                respond(['ok' => false, 'error' => 'Modelo no válido.'], 400);
            }
            $brand = clean($data['brand'] ?? '', 60);
            $model = clean($data['model'] ?? '', 60);
            if ($brand === '' && $model === '') {
                respond(['ok' => false, 'error' => 'Indica al menos la marca o el modelo.'], 400);
            }
            $db = $store->load();
            $id = clean($data['id'] ?? '', 40);
            $idx = $id !== '' ? findIndex($db['vehicleTypes'], static fn($t) => (string)($t['id'] ?? '') === $id) : null;
            $type = [
                'id' => $idx !== null ? $id : ('vt_' . bin2hex(random_bytes(5))),
                'brand' => $brand,
                'model' => $model,
                'name' => trim($brand . ' ' . $model),
                'description' => clean($data['description'] ?? '', 200),
                'active' => array_key_exists('active', $data) ? !empty($data['active']) : true,
                'variants' => $idx !== null && is_array($db['vehicleTypes'][$idx]['variants'] ?? null)
                    ? $db['vehicleTypes'][$idx]['variants']
                    : [],
            ];
            if ($idx === null) {
                $db['vehicleTypes'][] = $type;
            } else {
                $db['vehicleTypes'][$idx] = $type;
            }
            usort($db['vehicleTypes'], static fn($a, $b) => strcmp((string)($a['name'] ?? ''), (string)($b['name'] ?? '')));
            $store->write($db);
            respond(['ok' => true, 'type' => $type, 'db' => $db]);
        }

        case 'deleteVehicleType': {
            $id = clean($input['id'] ?? '', 40);
            $db = $store->load();
            $variantIds = [];
            foreach ($db['vehicleTypes'] ?? [] as $type) {
                if ((string)($type['id'] ?? '') !== $id) {
                    continue;
                }
                foreach ($type['variants'] ?? [] as $variant) {
                    $variantIds[(string)($variant['id'] ?? '')] = true;
                }
            }
            $db['vehicleTypes'] = array_values(array_filter(
                $db['vehicleTypes'],
                static fn($t) => (string)($t['id'] ?? '') !== $id
            ));
            foreach ($db['vehicles'] as &$vehicle) {
                if (isset($variantIds[(string)($vehicle['typeId'] ?? '')])) {
                    $vehicle['typeId'] = '';
                }
            }
            unset($vehicle);
            pruneDriverFuelAuthorizations($db);
            pruneLineRestrictions($db);
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveVehicleSubtype': {
            $data = $input['subtype'] ?? null;
            if (!is_array($data)) {
                respond(['ok' => false, 'error' => 'Variante no válida.'], 400);
            }
            $typeId = clean($data['typeId'] ?? '', 40);
            $size = clean($data['size'] ?? '', 20);
            $fuel = clean($data['fuel'] ?? '', 30);
            if ($typeId === '' || ($size === '' && $fuel === '')) {
                respond(['ok' => false, 'error' => 'Indica el tamaño o el combustible.'], 400);
            }
            $db = $store->load();
            $typeIdx = findIndex($db['vehicleTypes'], static fn($t) => (string)($t['id'] ?? '') === $typeId);
            if ($typeIdx === null) {
                respond(['ok' => false, 'error' => 'El modelo ya no existe.'], 404);
            }
            $variants = is_array($db['vehicleTypes'][$typeIdx]['variants'] ?? null) ? $db['vehicleTypes'][$typeIdx]['variants'] : [];
            $id = clean($data['id'] ?? '', 40);
            $subIdx = $id !== '' ? findIndex($variants, static fn($v) => (string)($v['id'] ?? '') === $id) : null;
            $subtype = [
                'id' => $subIdx !== null ? $id : ('vts_' . bin2hex(random_bytes(5))),
                'size' => $size,
                'fuel' => $fuel,
                'label' => trim($size . ($size !== '' && $fuel !== '' ? ' · ' : '') . $fuel),
                'description' => clean($data['description'] ?? '', 200),
                'active' => array_key_exists('active', $data) ? !empty($data['active']) : true,
            ];
            if ($subIdx === null) {
                $variants[] = $subtype;
            } else {
                $variants[$subIdx] = $subtype;
            }
            usort($variants, static fn($a, $b) => strcmp((string)($a['label'] ?? ''), (string)($b['label'] ?? '')));
            $db['vehicleTypes'][$typeIdx]['variants'] = $variants;
            pruneDriverFuelAuthorizations($db);
            pruneLineRestrictions($db);
            $store->write($db);
            respond(['ok' => true, 'subtype' => $subtype, 'db' => $db]);
        }

        case 'deleteVehicleSubtype': {
            $id = clean($input['id'] ?? '', 40);
            $db = $store->load();
            $removed = false;
            foreach ($db['vehicleTypes'] as &$type) {
                if (!is_array($type['variants'] ?? null)) {
                    continue;
                }
                $before = count($type['variants']);
                $type['variants'] = array_values(array_filter(
                    $type['variants'],
                    static fn($v) => (string)($v['id'] ?? '') !== $id
                ));
                if (count($type['variants']) !== $before) {
                    $removed = true;
                }
            }
            unset($type);
            if ($removed) {
                foreach ($db['vehicles'] as &$vehicle) {
                    if ((string)($vehicle['typeId'] ?? '') === $id) {
                        $vehicle['typeId'] = '';
                    }
                }
                unset($vehicle);
            }
            pruneDriverFuelAuthorizations($db);
            pruneLineRestrictions($db);
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveShift': {
            $data = $input['shift'] ?? null;
            if (!is_array($data) || (int)($data['code'] ?? 0) <= 0) {
                respond(['ok' => false, 'error' => 'Turno no válido.'], 400);
            }
            $db = $store->load();
            $original = (int)($input['originalCode'] ?? 0);
            $code = (int)$data['code'];
            $variants = [];
            foreach (['lv', 'sab', 'dom'] as $kind) {
                $v = $data['variants'][$kind] ?? null;
                if (!is_array($v) || ($v['start'] ?? '') === '' || ($v['end'] ?? '') === '') {
                    continue;
                }
                $start = clean($v['start'], 5);
                $end = clean($v['end'], 5);
                if (!preg_match('/^\d{2}:\d{2}$/', $start) || !preg_match('/^\d{2}:\d{2}$/', $end)) {
                    continue;
                }
                [$sh, $sm] = array_map('intval', explode(':', $start));
                [$eh, $em] = array_map('intval', explode(':', $end));
                $startMin = $sh * 60 + $sm;
                $endMin = $eh * 60 + $em;
                $duration = ($endMin - $startMin + 1440) % 1440;
                if ($duration < 30) {
                    $duration += 1440;
                }
                $variants[$kind] = [
                    'start' => $start,
                    'end' => $end,
                    'startMin' => $startMin,
                    'endMin' => $endMin,
                    'hours' => round($duration / 60, 2),
                    'line' => clean($v['line'] ?? $data['line'] ?? 'REF', 20),
                    'lineLabel' => clean($v['lineLabel'] ?? $v['line'] ?? $data['line'] ?? 'REF', 120),
                    'vehicle' => clean($v['vehicle'] ?? '', 20) ?: null,
                ];
            }
            if (!$variants) {
                respond(['ok' => false, 'error' => 'Añade al menos una variante horaria.'], 400);
            }
            $first = $variants['lv'] ?? reset($variants);
            $shift = [
                'code' => $code,
                'label' => clean($data['label'] ?? ('T' . str_pad((string)$code, 2, '0', STR_PAD_LEFT)), 20),
                'line' => $first['line'],
                'lineLabel' => $first['lineLabel'],
                'vehicle' => $first['vehicle'],
                'variants' => $variants,
            ];
            $idx = $original > 0 ? findIndex($db['shifts'], static fn($s) => (int)$s['code'] === $original) : null;
            $existing = $idx === null ? [] : $db['shifts'][$idx];
            foreach (['active' => true, 'inactiveFrom' => '', 'deepInactive' => false, 'lastSeen' => ''] as $field => $default) {
                $shift[$field] = $existing[$field] ?? $default;
            }
            if ($idx === null) {
                foreach ($db['shifts'] as $s) {
                    if ((int)$s['code'] === $code) {
                        respond(['ok' => false, 'error' => 'Ya existe un turno con ese código.'], 400);
                    }
                }
                $db['shifts'][] = $shift;
            } else {
                $db['shifts'][$idx] = $shift;
            }
            usort($db['shifts'], static fn($a, $b) => (int)$a['code'] <=> (int)$b['code']);
            $db['needs'] = Store::calculateNeeds($db);
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'deleteShift': {
            $code = (int)($input['code'] ?? 0);
            $db = $store->load();
            $db['shifts'] = array_values(array_filter($db['shifts'], static fn($s) => (int)$s['code'] !== $code));
            $db['needs'] = Store::calculateNeeds($db);
            foreach ($db['assignments'] as $month => $rows) {
                foreach ($rows as $k => $v) {
                    if ((string)$v === (string)$code) {
                        unset($rows[$k]);
                    }
                }
                $db['assignments'][$month] = $rows;
            }
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveHolidays': {
            $rows = $input['holidays'] ?? null;
            if (!is_array($rows)) {
                respond(['ok' => false, 'error' => 'Festivos no válidos.'], 400);
            }
            $out = [];
            foreach ($rows as $h) {
                $date = clean(is_array($h) ? ($h['date'] ?? '') : $h, 10);
                if (!dateOk($date)) {
                    continue;
                }
                $out[$date] = ['date' => $date, 'name' => clean(is_array($h) ? ($h['name'] ?? '') : '', 80) ?: 'Festivo'];
            }
            ksort($out);
            $db = $store->load();
            $db['holidays'] = array_values($out);
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveNeeds': {
            // Las necesidades ya no se editan: se calculan desde los turnos.
            // Se mantiene la acción por compatibilidad con clientes antiguos.
            $db = $store->load();
            $db['needs'] = Store::calculateNeeds($db);
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        // El colaborador solo guarda qué mes está consultando. Es una
        // preferencia de navegación, no una modificación de los ajustes.
        case 'setCurrentMonth': {
            if ((string)($user['role'] ?? '') !== 'colaborador') {
                respond(['ok' => false, 'error' => 'Acción no permitida.'], 403);
            }
            $month = clean($input['month'] ?? '', 7);
            if (!monthOk($month)) {
                respond(['ok' => false, 'error' => 'Mes no válido.'], 400);
            }
            $db = $store->load();
            $db['settings']['currentMonth'] = $month;
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveSettings': {
            $data = $input['settings'] ?? null;
            if (!is_array($data)) {
                respond(['ok' => false, 'error' => 'Ajustes no válidos.'], 400);
            }
            $db = $store->load();
            $month = clean($data['currentMonth'] ?? '', 7);
            if (monthOk($month)) {
                $db['settings']['currentMonth'] = $month;
            }
            $db['settings']['maxConsecutive'] = max(1, min(14, (int)($data['maxConsecutive'] ?? 5)));
            $db['settings']['exceptionDays'] = max(0, min(14, (int)($data['exceptionDays'] ?? 6)));
            $db['settings']['exceptionRest'] = max(1, min(168, (int)($data['exceptionRest'] ?? 48)));
            $db['settings']['minRest'] = max(0, min(24, (int)($data['minRest'] ?? 12)));
            $db['settings']['reducedRestMin'] = max(1, min(24, (int)($data['reducedRestMin'] ?? 9)));
            $db['settings']['maxReducedRests'] = max(0, min(14, (int)($data['maxReducedRests'] ?? 3)));
            $freeDays = [];
            foreach ((array)($data['freeDaysByMonth'] ?? ($db['settings']['freeDaysByMonth'] ?? [])) as $month => $value) {
                if (preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', (string)$month)) {
                    $freeDays[(string)$month] = max(0, min(count(Store::monthDays((string)$month)), (int)$value));
                }
            }
            $db['settings']['freeDaysByMonth'] = $freeDays;
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'saveAbsence': {
            $data = $input['absence'] ?? null;
            if (!is_array($data)) {
                respond(['ok' => false, 'error' => 'Ausencia no válida.'], 400);
            }
            $db = $store->load();
            $driverId = clean($data['driverId'] ?? '', 32);
            $from = clean($data['from'] ?? '', 10);
            $to = clean($data['to'] ?? '', 10);
            $type = Store::normaliseStatusValue(clean($data['type'] ?? 'VA', 2));
            if ($driverId === '' || !dateOk($from) || !dateOk($to) || $to < $from || !in_array($type, Store::ABSENCE_CODES, true)) {
                respond(['ok' => false, 'error' => 'Datos de la ausencia incorrectos.'], 400);
            }
            $id = clean($data['id'] ?? '', 40) ?: ('abs-' . bin2hex(random_bytes(4)));
            $absence = [
                'id' => $id,
                'driverId' => $driverId,
                'from' => $from,
                'to' => $to,
                'type' => $type,
                'note' => clean($data['note'] ?? '', 120),
            ];
            $idx = findIndex($db['absences'], static fn($a) => (string)$a['id'] === $id);
            if ($idx === null) {
                $db['absences'][] = $absence;
            } else {
                $db['absences'][$idx] = $absence;
            }
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'deleteAbsence': {
            $id = clean($input['id'] ?? '', 40);
            $db = $store->load();
            $db['absences'] = array_values(array_filter($db['absences'], static fn($a) => (string)$a['id'] !== $id));
            $store->write($db);
            respond(['ok' => true, 'db' => $db]);
        }

        case 'autoAssign': {
            $month = clean($input['month'] ?? '', 7);
            if (!monthOk($month)) {
                respond(['ok' => false, 'error' => 'Mes no válido.'], 400);
            }
            $result = $store->autoAssign($month, true);
            respond(['ok' => true, 'db' => $result['db'], 'stats' => $result['stats']]);
        }

        case 'reset': {
            $month = clean($input['month'] ?? '', 7);
            $db = $store->reset($month !== '' && monthOk($month) ? $month : null);
            respond(['ok' => true, 'db' => $db]);
        }

        default:
            respond(['ok' => false, 'error' => 'Acción desconocida: ' . $action], 404);
    }
} catch (RuntimeException $e) {
    respond(['ok' => false, 'error' => $e->getMessage()], 400);
} catch (Throwable $e) {
    respond(['ok' => false, 'error' => $e->getMessage()], 500);
}
