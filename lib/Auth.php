<?php
declare(strict_types=1);

/**
 * Usuarios, sesiones y permisos de la aplicación de gestión.
 *
 * Las cuentas se guardan en data/users.json, separadas del estado de negocio
 * (db.json). Así, restaurar la plantilla no elimina los usuarios ni sus contraseñas.
 *
 * La primera vez se crea la cuenta admin/admin con la marca mustChange. Hasta
 * que se cambien el usuario y la contraseña, la API solo permite bootstrap,
 * cambio de credenciales y cierre de sesión.
 */
final class Auth
{
    /** Intentos fallidos consecutivos que dejan una cuenta bloqueada. */
    public const MAX_FAILED_LOGINS = 3;

    private string $file;
    private string $lockFile;
    private ?string $loginStatus = null;

    public function __construct(private readonly string $dir)
    {
        $this->file = $dir . '/users.json';
        $this->lockFile = $dir . '/users.lock';
    }

    /**
     * Ruta base donde se sirve la aplicación, deducida de la URL del script.
     * Funciona igual en /GesKua/, /app/GesKua/ o en la raíz de un dominio.
     */
    public static function basePath(): string
    {
        $script = str_replace('\\', '/', (string)($_SERVER['SCRIPT_NAME'] ?? ''));
        $dir = str_replace('\\', '/', dirname($script));
        if ($dir === '/' || $dir === '.' || $dir === '') {
            return '/';
        }
        return rtrim($dir, '/') . '/';
    }

    /** Detecta HTTPS también cuando hay un proxy o balanceador delante. */
    private static function isHttps(): bool
    {
        if (!empty($_SERVER['HTTPS']) && strtolower((string)$_SERVER['HTTPS']) !== 'off') {
            return true;
        }
        $proto = strtolower(trim(explode(',', (string)($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''))[0]));
        if ($proto === 'https') {
            return true;
        }
        return (string)($_SERVER['SERVER_PORT'] ?? '') === '443';
    }

    /** Configura la cookie de sesión y la inicia. */
    public static function boot(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        session_name('geskua_sid');
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => self::basePath(),
            'domain' => '',
            'secure' => self::isHttps(),
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        // Un fallo de sesión no debe romper la redirección al login ni el JSON.
        if (!@session_start()) {
            error_log('GesKua: no se pudo iniciar la sesión PHP (revisa session.save_path).');
        }
    }

    /** @return array<string,mixed> */
    private function seed(): array
    {
        $now = date('c');
        return [
            'version' => 1,
            'users' => [[
                'id' => 'u_admin',
                'username' => 'admin',
                'role' => 'admin',
                'passwordHash' => password_hash('admin', PASSWORD_DEFAULT),
                'mustChange' => true,
                'active' => true,
                'failedLogins' => 0,
                'locked' => false,
                'lockedAt' => null,
                'createdAt' => $now,
                'updatedAt' => $now,
            ]],
        ];
    }

    /** @return array<string,mixed> */
    private function read(): array
    {
        if (!is_file($this->file)) {
            $data = $this->seed();
            $this->write($data);
            return $data;
        }
        $raw = @file_get_contents($this->file);
        $data = $raw === false ? null : json_decode($raw, true);
        if (!is_array($data) || !isset($data['users']) || !is_array($data['users'])) {
            $data = $this->seed();
            $this->write($data);
        }
        $data['users'] = array_values(array_filter($data['users'], 'is_array'));
        return $data;
    }

    /** @param array<string,mixed> $data */
    private function write(array $data): void
    {
        $tmp = $this->file . '.tmp.' . getmypid();
        $json = json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        if ($json === false) {
            throw new RuntimeException('No se pudo serializar el archivo de usuarios.');
        }
        if (file_put_contents($tmp, $json) === false) {
            throw new RuntimeException('No se pudo escribir el archivo de usuarios.');
        }
        if (!@rename($tmp, $this->file)) {
            @unlink($tmp);
            throw new RuntimeException('No se pudo guardar el archivo de usuarios.');
        }
        @chmod($this->file, 0600);
    }

    /**
     * Ejecuta una modificación con bloqueo para no perder cambios en escrituras
     * simultáneas. El callback recibe el documento por referencia.
     */
    private function mutate(callable $fn): mixed
    {
        $lock = @fopen($this->lockFile, 'c');
        if ($lock) {
            @flock($lock, LOCK_EX);
        }
        try {
            $data = $this->read();
            $result = $fn($data);
            $this->write($data);
            return $result;
        } finally {
            if ($lock) {
                @flock($lock, LOCK_UN);
                @fclose($lock);
            }
        }
    }

    /** @param array<string,mixed> $u */
    public static function publicUser(array $u): array
    {
        return [
            'id' => (string)($u['id'] ?? ''),
            'username' => (string)($u['username'] ?? ''),
            'role' => (string)($u['role'] ?? 'editor'),
            'mustChange' => !empty($u['mustChange']),
            'active' => !empty($u['active']),
            'failedLogins' => max(0, (int)($u['failedLogins'] ?? 0)),
            'locked' => !empty($u['locked']),
            'lockedAt' => $u['lockedAt'] ?? null,
            'createdAt' => $u['createdAt'] ?? null,
            'updatedAt' => $u['updatedAt'] ?? null,
        ];
    }

    /** @return array<int,array<string,mixed>> */
    public function listUsers(): array
    {
        $users = array_map([self::class, 'publicUser'], $this->read()['users']);
        // Orden habitual: Superadministrador, Administrador, Colaborador, Lector.
        $rank = ['admin' => 0, 'editor' => 1, 'colaborador' => 2, 'lector' => 3];
        usort($users, static function (array $a, array $b) use ($rank): int {
            $ra = $rank[$a['role']] ?? 4;
            $rb = $rank[$b['role']] ?? 4;
            if ($ra !== $rb) {
                return $ra <=> $rb;
            }
            return strcasecmp($a['username'], $b['username']);
        });
        return $users;
    }

    /** @return array<string,mixed>|null */
    public function findByUsername(string $username): ?array
    {
        $needle = trim($username);
        foreach ($this->read()['users'] as $u) {
            if (strcasecmp((string)$u['username'], $needle) === 0) {
                return $u;
            }
        }
        return null;
    }

    /** @return array<string,mixed>|null */
    public function findById(string $id): ?array
    {
        foreach ($this->read()['users'] as $u) {
            if ((string)$u['id'] === $id) {
                return $u;
            }
        }
        return null;
    }

    /** Devuelve el usuario de la sesión actual o null. */
    public function currentUser(): ?array
    {
        $id = (string)($_SESSION['uid'] ?? '');
        if ($id === '') {
            return null;
        }
        $u = $this->findById($id);
        if (!$u || empty($u['active'])) {
            unset($_SESSION['uid']);
            return null;
        }
        return self::publicUser($u);
    }

    /** Indica si aún queda alguna cuenta administradora por configurar. */
    public function needsSetup(): bool
    {
        foreach ($this->read()['users'] as $u) {
            if ((string)($u['role'] ?? '') === 'admin' && !empty($u['mustChange'])) {
                return true;
            }
        }
        return false;
    }

    /** Estado del último intento de acceso: null o «locked». */
    public function loginStatus(): ?string
    {
        return $this->loginStatus;
    }

    /**
     * Comprueba credenciales y devuelve el usuario público, o null.
     *
     * Solo se cuentan los fallos de contraseña de cuentas existentes y activas.
     * Al tercer fallo consecutivo la cuenta queda bloqueada y solo un
     * administrador o superadministrador puede desbloquearla.
     */
    public function login(string $username, string $password): ?array
    {
        $this->loginStatus = null;
        $u = $this->findByUsername($username);
        if (!$u || empty($u['active'])) {
            return null;
        }
        $id = (string)$u['id'];
        if (!empty($u['locked'])) {
            $this->loginStatus = 'locked';
            return null;
        }
        if (!password_verify($password, (string)$u['passwordHash'])) {
            if ($this->registerFailedLogin($id)) {
                $this->loginStatus = 'locked';
            }
            return null;
        }

        // Un acceso correcto reinicia el contador de intentos fallidos.
        if (!empty($u['failedLogins'])) {
            $this->clearFailedLogins($id);
            $u = $this->findById($id) ?? $u;
        }
        if (password_needs_rehash((string)$u['passwordHash'], PASSWORD_DEFAULT)) {
            $this->mutate(static function (array &$data) use ($id, $password): void {
                foreach ($data['users'] as $i => $row) {
                    if ((string)$row['id'] === $id) {
                        $data['users'][$i]['passwordHash'] = password_hash($password, PASSWORD_DEFAULT);
                        break;
                    }
                }
            });
        }
        session_regenerate_id(true);
        $_SESSION['uid'] = $id;
        return self::publicUser($u);
    }

    /** Incrementa el contador y devuelve true si la cuenta acaba bloqueada. */
    private function registerFailedLogin(string $id): bool
    {
        return $this->mutate(function (array &$data) use ($id): bool {
            foreach ($data['users'] as $i => $row) {
                if ((string)$row['id'] !== $id) {
                    continue;
                }
                if (!empty($data['users'][$i]['locked'])) {
                    return true;
                }
                $data['users'][$i]['failedLogins'] = max(0, (int)($row['failedLogins'] ?? 0)) + 1;
                $data['users'][$i]['updatedAt'] = date('c');
                if ($data['users'][$i]['failedLogins'] >= self::MAX_FAILED_LOGINS) {
                    $data['users'][$i]['locked'] = true;
                    $data['users'][$i]['lockedAt'] = date('c');
                }
                return !empty($data['users'][$i]['locked']);
            }
            return false;
        });
    }

    /** Pone a cero el contador tras un acceso correcto. */
    private function clearFailedLogins(string $id): void
    {
        $this->mutate(static function (array &$data) use ($id): void {
            foreach ($data['users'] as $i => $row) {
                if ((string)$row['id'] === $id) {
                    $data['users'][$i]['failedLogins'] = 0;
                    $data['users'][$i]['locked'] = false;
                    $data['users'][$i]['lockedAt'] = null;
                    $data['users'][$i]['updatedAt'] = date('c');
                    return;
                }
            }
        });
    }

    /** Desbloquea una cuenta y reinicia su contador de intentos. */
    public function unlockUser(string $id, string $actorId): array
    {
        return $this->mutate(static function (array &$data) use ($id, $actorId): array {
            foreach ($data['users'] as $i => $row) {
                if ((string)$row['id'] === $id) {
                    $data['users'][$i]['failedLogins'] = 0;
                    $data['users'][$i]['locked'] = false;
                    $data['users'][$i]['lockedAt'] = null;
                    $data['users'][$i]['unlockedAt'] = date('c');
                    $data['users'][$i]['unlockedBy'] = $actorId;
                    $data['users'][$i]['updatedAt'] = date('c');
                    return self::publicUser($data['users'][$i]);
                }
            }
            throw new RuntimeException('El usuario ya no existe.');
        });
    }

    public function logout(): void
    {
        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', [
                'expires' => time() - 42000,
                'path' => $params['path'] ?? self::basePath(),
                'domain' => $params['domain'] ?? '',
                'secure' => (bool)($params['secure'] ?? false),
                'httponly' => (bool)($params['httponly'] ?? true),
                'samesite' => 'Lax',
            ]);
        }
        if (session_status() === PHP_SESSION_ACTIVE) {
            session_destroy();
        }
    }

    /** Valida que un nombre de usuario sea razonable. */
    private static function assertUsername(string $username): string
    {
        $username = trim($username);
        if ($username === '') {
            throw new RuntimeException('El nombre de usuario es obligatorio.');
        }
        if (!preg_match('/^[\p{L}\p{N}._-]{3,40}$/u', $username)) {
            throw new RuntimeException('El usuario debe tener entre 3 y 40 caracteres (letras, números, punto, guion o guion bajo).');
        }
        return $username;
    }

    /** @param array<int,array<string,mixed>> $users */
    private static function assertUsernameFree(array $users, string $username, string $exceptId = ''): void
    {
        foreach ($users as $u) {
            if ((string)$u['id'] === $exceptId) {
                continue;
            }
            if (strcasecmp((string)$u['username'], $username) === 0) {
                throw new RuntimeException('Ya existe un usuario con ese nombre.');
            }
        }
    }

    private static function assertPassword(string $password): void
    {
        if (strlen($password) < 6) {
            throw new RuntimeException('La contraseña debe tener al menos 6 caracteres.');
        }
        if (strlen($password) > 200) {
            throw new RuntimeException('La contraseña es demasiado larga.');
        }
    }

    /**
     * Cambia las credenciales de la propia cuenta. En la primera puesta en
     * marcha exige cambiar tanto el usuario como la contraseña.
     *
     * @return array<string,mixed>
     */
    public function changeCredentials(string $id, string $currentPassword, string $newUsername, string $newPassword): array
    {
        return $this->mutate(static function (array &$data) use ($id, $currentPassword, $newUsername, $newPassword): array {
            $index = null;
            foreach ($data['users'] as $i => $u) {
                if ((string)$u['id'] === $id) {
                    $index = (int)$i;
                    break;
                }
            }
            if ($index === null) {
                throw new RuntimeException('La cuenta ya no existe.');
            }
            $user = &$data['users'][$index];
            if (!password_verify($currentPassword, (string)$user['passwordHash'])) {
                throw new RuntimeException('La contraseña actual no es correcta.');
            }

            $mustChange = !empty($user['mustChange']);
            $username = trim($newUsername);
            $password = (string)$newPassword;

            if ($mustChange) {
                if ($username === '' || $password === '') {
                    throw new RuntimeException('Debes indicar un nuevo usuario y una nueva contraseña.');
                }
                if (strcasecmp($username, 'admin') === 0) {
                    throw new RuntimeException('El nuevo usuario no puede seguir siendo «admin».');
                }
                if (strcasecmp($password, 'admin') === 0) {
                    throw new RuntimeException('La nueva contraseña no puede ser «admin».');
                }
                self::assertPassword($password);
            } elseif ($username === '' && $password === '') {
                throw new RuntimeException('No hay cambios que guardar.');
            }

            if ($username !== '' && strcasecmp($username, (string)$user['username']) !== 0) {
                $username = self::assertUsername($username);
                self::assertUsernameFree($data['users'], $username, $id);
                $user['username'] = $username;
            }
            if ($password !== '') {
                self::assertPassword($password);
                $user['passwordHash'] = password_hash($password, PASSWORD_DEFAULT);
            }

            $user['mustChange'] = false;
            $user['updatedAt'] = date('c');
            return self::publicUser($user);
        });
    }

    /**
     * Crea o actualiza una cuenta desde el panel de administración.
     *
     * @param array<string,mixed> $input
     * @return array<string,mixed>
     */
    public function saveUser(array $input, string $actorId): array
    {
        return $this->mutate(static function (array &$data) use ($input, $actorId): array {
            $id = trim((string)($input['id'] ?? ''));
            $username = self::assertUsername((string)($input['username'] ?? ''));
            $role = (string)($input['role'] ?? 'editor');
            if (!in_array($role, ['admin', 'editor', 'lector', 'colaborador'], true)) {
                throw new RuntimeException('Rol no válido.');
            }
            $password = (string)($input['password'] ?? '');

            if ($id === '') {
                self::assertUsernameFree($data['users'], $username);
                self::assertPassword($password);
                $now = date('c');
                $user = [
                    'id' => 'u_' . bin2hex(random_bytes(4)),
                    'username' => $username,
                    'role' => $role,
                    'passwordHash' => password_hash($password, PASSWORD_DEFAULT),
                    'mustChange' => false,
                    'active' => true,
                    'failedLogins' => 0,
                    'locked' => false,
                    'lockedAt' => null,
                    'createdAt' => $now,
                    'updatedAt' => $now,
                ];
                $data['users'][] = $user;
                return self::publicUser($user);
            }

            $index = null;
            foreach ($data['users'] as $i => $u) {
                if ((string)$u['id'] === $id) {
                    $index = (int)$i;
                    break;
                }
            }
            if ($index === null) {
                throw new RuntimeException('El usuario ya no existe.');
            }
            $user = &$data['users'][$index];

            if ((string)$user['role'] === 'admin' && $role !== 'admin') {
                $admins = 0;
                foreach ($data['users'] as $u) {
                    if ((string)$u['role'] === 'admin' && !empty($u['active'])) {
                        $admins++;
                    }
                }
                if ($admins <= 1) {
                    throw new RuntimeException('Debe existir al menos un administrador.');
                }
            }

            self::assertUsernameFree($data['users'], $username, $id);
            $user['username'] = $username;
            $user['role'] = $role;
            if ($password !== '') {
                self::assertPassword($password);
                $user['passwordHash'] = password_hash($password, PASSWORD_DEFAULT);
                $user['mustChange'] = false;
            }
            $user['updatedAt'] = date('c');
            return self::publicUser($user);
        });
    }

    /** Elimina una cuenta; no permite borrarse a sí mismo ni quedarse sin admins. */
    public function deleteUser(string $id, string $actorId): void
    {
        if ($id === $actorId) {
            throw new RuntimeException('No puedes eliminar tu propia cuenta.');
        }
        $this->mutate(static function (array &$data) use ($id): void {
            $found = null;
            $admins = 0;
            foreach ($data['users'] as $u) {
                if ((string)$u['id'] === $id) {
                    $found = $u;
                }
                if ((string)$u['role'] === 'admin' && !empty($u['active'])) {
                    $admins++;
                }
            }
            if ($found === null) {
                throw new RuntimeException('El usuario ya no existe.');
            }
            if ((string)$found['role'] === 'admin' && $admins <= 1) {
                throw new RuntimeException('Debe existir al menos un administrador.');
            }
            $data['users'] = array_values(array_filter(
                $data['users'],
                static fn(array $u): bool => (string)$u['id'] !== $id
            ));
        });
    }
}
