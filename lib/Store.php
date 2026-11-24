<?php
declare(strict_types=1);

/**
 * Almacén JSON de la aplicación de gestión.
 *
 * El estado vivo está en data/db.json. data/seed.json es inmutable y sirve
 * para restaurar la plantilla vacía o inicializar la base la primera vez.
 */
final class Store
{
    /** Códigos de ausencia: PI/PC/PF son permisos y HR son horas registro. */
    public const ABSENCE_CODES = ['VA', 'BA', 'AP', 'PI', 'PC', 'PF', 'HS', 'HR'];
    private const STATUS_CODES = ['D', 'X', ...self::ABSENCE_CODES];
    private const LEGACY_STATUS = ['V' => 'VA', 'B' => 'BA', 'A' => 'AP', 'P' => 'PI', 'R' => 'HR'];
    /** Días que un elemento puede permanecer inactivo antes de archivarse. */
    public const INACTIVE_DAYS = 40;
    private const CSV_KEYS = ['drivers' => 'id', 'vehicles' => 'id', 'shifts' => 'code'];

    private string $seedFile;
    private string $dbFile;
    private string $lockFile;
    /** @var array<string,mixed>|null */
    private ?array $db = null;

    public function __construct(private readonly string $dir)
    {
        $this->seedFile = $dir . '/seed.json';
        $this->dbFile = $dir . '/db.json';
        $this->lockFile = $dir . '/db.lock';
    }

    public function seed(): array
    {
        $raw = @file_get_contents($this->seedFile);
        if ($raw === false) {
            throw new RuntimeException('No se encuentra data/seed.json.');
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            throw new RuntimeException('data/seed.json no es válido.');
        }
        return $data;
    }

    public function load(): array
    {
        if ($this->db === null) {
            if (!is_file($this->dbFile)) {
                $this->write($this->seed());
            } else {
                $raw = @file_get_contents($this->dbFile);
                $data = $raw === false ? null : json_decode($raw, true);
                $this->db = is_array($data) ? $data : $this->seed();
            }
            $before = $this->db;
            $this->normalise();
            // Persiste la migración de códigos antiguos sin esperar a otro guardado.
            if ($this->db !== $before) {
                $this->write($this->db);
            }
        }
        return $this->db;
    }

    /** Convierte los códigos históricos V/B/A/P/R a VA/BA/AP/PI/HR. */
    public static function normaliseStatusValue(string $value): string
    {
        $value = strtoupper(trim($value));
        return self::LEGACY_STATUS[$value] ?? $value;
    }

    /** Toda jornada computable: turno numérico o jornada sin turno (X). */
    public static function isWorkCode(string $value): bool
    {
        return ctype_digit($value) || $value === 'X';
    }

    /** Días libres por mes: redondeo de ((días × 8 h) − 166 h) / 8 h. */
    public static function defaultFreeDays(string $month): int
    {
        if (!preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', $month)) {
            return 0;
        }
        return max(0, (int)round((count(self::monthDays($month)) * 8 - 166) / 8));
    }

    /** Días libres vigentes para un mes: valor de Ajustes o cálculo por defecto. */
    public static function freeDaysFor(array $db, string $month): int
    {
        $override = $db['settings']['freeDaysByMonth'][$month] ?? null;
        if ($override !== null && $override !== '') {
            return max(0, min(count(self::monthDays($month)), (int)$override));
        }
        return self::defaultFreeDays($month);
    }

    /** Solo conductores activos entran en el cuadrante y en la autoasignación. */
    public static function isRosterDriver(array $driver): bool
    {
        if (empty($driver['active']) || !empty($driver['deepInactive'])) {
            return false;
        }
        return in_array(strtolower(trim((string)($driver['role'] ?? ''))), ['conductor', 'conductora'], true);
    }

    /** Un elemento archivado no aparece en listados ni se puede reasignar. */
    public static function isVisible(array $entity): bool
    {
        return empty($entity['deepInactive']);
    }

    private static function validDate(string $date): bool
    {
        if ($date === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            return false;
        }
        $parsed = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
        return $parsed !== false && $parsed->format('Y-m-d') === $date;
    }

    public static function daysSince(string $from, string $today): int
    {
        if (!self::validDate($from) || !self::validDate($today)) {
            return PHP_INT_MAX;
        }
        $a = DateTimeImmutable::createFromFormat('!Y-m-d', $from);
        $b = DateTimeImmutable::createFromFormat('!Y-m-d', $today);
        return $a === false || $b === false ? PHP_INT_MAX : $a->diff($b)->days;
    }

    /** Completa los campos del ciclo inactivo → reactivado → archivado. */
    public static function normaliseLifecycle(array &$entity, string $today): void
    {
        $rawActive = !empty($entity['active']);
        $entity['deepInactive'] = !empty($entity['deepInactive']);
        $entity['active'] = $rawActive && !$entity['deepInactive'];
        $from = trim((string)($entity['inactiveFrom'] ?? ''));
        $seen = trim((string)($entity['lastSeen'] ?? ''));
        $missing = trim((string)($entity['missingSince'] ?? ''));
        $entity['inactiveFrom'] = self::validDate($from) ? $from : '';
        $entity['lastSeen'] = self::validDate($seen) ? $seen : '';
        $entity['missingSince'] = self::validDate($missing) ? $missing : '';
        // Estado que tenía antes de desaparecer del Excel. En datos antiguos
        // archivados se asume activo; en los demás se toma el estado actual.
        $prior = $entity['stateBeforeAbsence'] ?? null;
        $entity['stateBeforeAbsence'] = $prior === null
            ? ($entity['deepInactive'] ? true : $rawActive)
            : !empty($prior);
        if ($entity['active']) {
            $entity['inactiveFrom'] = '';
        } elseif ($entity['inactiveFrom'] === '') {
            $entity['inactiveFrom'] = $today;
        }
    }

    private static function csvText(mixed $value, int $max = 500): string
    {
        return mb_substr(trim((string)$value), 0, $max, 'UTF-8');
    }

    private static function csvBool(mixed $value, bool $default = false): bool
    {
        $text = mb_strtolower(trim((string)$value));
        if ($text === '') {
            return $default;
        }
        return in_array($text, ['1', 's', 'si', 'sí', 'true', 'yes', 'y', 'activo', 'activa'], true);
    }

    private static function csvHas(array $row, string $key): bool
    {
        return array_key_exists($key, $row);
    }

    /**
     * Normaliza texto de Excel: sin mayúsculas, acentos ni espacios sobrantes.
     * Así «Taller», «TALLER» o «taller » equivalen a «taller».
     */
    private static function csvSlug(string $value): string
    {
        $value = mb_strtolower(trim($value), 'UTF-8');
        $value = str_replace(
            ['á', 'é', 'í', 'ó', 'ú', 'ü', 'ñ'],
            ['a', 'e', 'i', 'o', 'u', 'u', 'n'],
            $value
        );
        return preg_replace('/[^a-z0-9]+/', '', $value) ?? '';
    }

    /** Enteros tolerantes con el formato numérico de Excel en español. */
    private static function csvInt(mixed $value, int $fallback = 0): int
    {
        $text = trim((string)$value);
        if ($text === '') {
            return $fallback;
        }
        if (preg_match('/^\d{1,3}(?:\.\d{3})+$/', $text)) {
            $text = str_replace('.', '', $text); // 12.345 → 12345
        } else {
            $text = str_replace(',', '.', $text); // 12,5 → 12.5
        }
        return is_numeric($text) ? (int)round((float)$text) : $fallback;
    }

    /** Estado de vehículo: acepta variantes y conserva el anterior si no se reconoce. */
    private static function csvVehicleStatus(string $value, string $fallback): string
    {
        $slug = self::csvSlug($value);
        if (in_array($slug, ['disponible', 'dispo', 'libre', 'ok'], true)) {
            return 'disponible';
        }
        if (in_array($slug, [
            'taller', 'talleres', 'entaller', 'reparacion', 'enreparacion', 'reparando',
            'averiado', 'averia', 'averiada', 'fueraservicio', 'baja',
        ], true)) {
            return 'taller';
        }
        if (in_array($slug, ['reserva', 'reservado', 'reservada'], true)) {
            return 'reserva';
        }
        return in_array($fallback, ['disponible', 'taller', 'reserva'], true) ? $fallback : 'disponible';
    }

    private static function entityKey(array $entity, string $kind): string
    {
        return $kind === 'shifts'
            ? (string)(int)($entity['code'] ?? 0)
            : trim((string)($entity['id'] ?? ''));
    }

    /**
     * Estado solicitado por la columna «Activo» del Excel/CSV.
     * `null` significa que la columna no viene o no es reconocible.
     */
    private static function csvWantedActive(array $row): ?bool
    {
        if (!array_key_exists('active', $row)) {
            return null;
        }
        $value = strtolower(trim((string)$row['active']));
        if ($value === '' || in_array($value, ['null', 'na', 'n/a'], true)) {
            return null;
        }
        if (in_array($value, ['1', 'true', 'yes', 'y', 'si', 'sí', 's', 'activo', 'active', 'alta'], true)) {
            return true;
        }
        if (in_array($value, ['0', 'false', 'no', 'n', 'inactivo', 'inactive', 'baja', 'excedencia'], true)) {
            return false;
        }
        return null;
    }

    /**
     * Aplica la fila presente al ciclo de vida. La columna «Activo» manda;
     * si no viene, se recupera el estado anterior a la desaparición.
     *
     * @return array{array,bool,bool} entidad, se reactiva, se da de baja
     */
    private static function applyPresentLifecycle(array $entity, ?bool $wanted, string $today): array
    {
        $wasActive = !empty($entity['active']);
        $target = $wanted !== null ? $wanted : !empty($entity['stateBeforeAbsence']);
        $entity['deepInactive'] = false;
        $entity['missingSince'] = '';
        $entity['lastSeen'] = $today;
        if ($target !== $wasActive) {
            $entity['active'] = $target;
            $entity['inactiveFrom'] = $target ? '' : $today;
            return [$entity, $target, !$target];
        }
        $entity['active'] = $target;
        $entity['inactiveFrom'] = $target ? '' : ((string)($entity['inactiveFrom'] ?? '') ?: $today);
        return [$entity, false, false];
    }

    /** Aplica un CSV de personal, vehículos o turnos y devuelve el resumen. */
    public static function applyCsvImport(array $db, string $kind, array $rows, string $today): array
    {
        if (!isset(self::CSV_KEYS[$kind]) || !is_array($db[$kind] ?? null)) {
            throw new InvalidArgumentException('Tipo de CSV no válido.');
        }
        $key = self::CSV_KEYS[$kind];
        $stats = ['created' => 0, 'updated' => 0, 'changed' => 0, 'deactivated' => 0, 'reactivated' => 0, 'archived' => 0, 'ignored' => 0];
        $present = [];
        foreach ($rows as $row) {
            if (!is_array($row)) {
                continue;
            }
            $id = self::entityKey($row, $kind);
            if ($id === '' || ($kind === 'shifts' && (int)$id <= 0)) {
                continue;
            }
            $present[$id] = true;
        }

        // Primero se evalúa quién falta en el Excel: inactivo hoy y archivado
        // solo después de 40 días SIN APARECER, no por estar inactivo.
        $brokenIds = [];
        foreach ($db[$kind] as &$entity) {
            if (!is_array($entity)) {
                continue;
            }
            $entityId = self::entityKey($entity, $kind);
            if (isset($present[$entityId]) || !empty($entity['deepInactive'])) {
                continue;
            }
            $missing = trim((string)($entity['missingSince'] ?? ''));
            if (!self::validDate($missing)) {
                $missing = $today;
                $entity['missingSince'] = $today;
                $entity['stateBeforeAbsence'] = !empty($entity['active']);
            }
            if (!empty($entity['active'])) {
                $entity['active'] = false;
                $entity['inactiveFrom'] = $today;
                $stats['deactivated']++;
                $brokenIds[] = $entityId;
            }
            if (self::daysSince($missing, $today) >= self::INACTIVE_DAYS) {
                $entity['deepInactive'] = true;
                $entity['active'] = false;
                $stats['archived']++;
                if (!in_array($entityId, $brokenIds, true)) {
                    $brokenIds[] = $entityId;
                }
            }
        }
        unset($entity);
        if ($kind === 'drivers') {
            foreach ($brokenIds as $id) {
                self::breakPairingsFor($db, $id, $today);
            }
        }

        foreach ($rows as $row) {
            if (!is_array($row)) {
                $stats['ignored']++;
                continue;
            }
            $id = self::entityKey($row, $kind);
            if ($id === '' || ($kind === 'shifts' && (int)$id <= 0)) {
                $stats['ignored']++;
                continue;
            }
            $row[$key] = $id;
            // Las parejas se gestionan en la app: un CSV nunca reasigna un compañero.
            if ($kind === 'drivers') {
                unset($row['partnerId']);
            }
            $idx = null;
            foreach ($db[$kind] as $i => $entity) {
                if (is_array($entity) && self::entityKey($entity, $kind) === $id) {
                    $idx = $i;
                    break;
                }
            }
            $existing = $idx === null ? [] : $db[$kind][$idx];
            $wanted = self::csvWantedActive($row);
            $reactivated = false;
            $deactivated = false;
            if ($idx === null) {
                $active = $wanted ?? true;
                $base = [
                    'active' => $active,
                    'inactiveFrom' => $active ? '' : $today,
                    'deepInactive' => false,
                    'lastSeen' => $today,
                    'missingSince' => '',
                    'stateBeforeAbsence' => $active,
                ];
            } else {
                // Un archivado puede reaparecer: recupera su estado anterior,
                // siempre que la columna «Activo» no indique lo contrario.
                [$base, $reactivated, $deactivated] = self::applyPresentLifecycle($existing, $wanted, $today);
                if ($reactivated) {
                    $stats['reactivated']++;
                }
                if ($deactivated) {
                    $stats['deactivated']++;
                }
            }
            if ($kind === 'drivers') {
                $entity = self::driverFromCsvRow($row, $base, $today);
            } elseif ($kind === 'vehicles') {
                $entity = self::vehicleFromCsvRow($row, $base, $db);
            } else {
                $entity = self::shiftFromCsvRow($row, $base);
            }
            if ($entity === null) {
                $stats['ignored']++;
                continue;
            }
            $entity['active'] = !empty($base['active']);
            $entity['inactiveFrom'] = (string)($base['inactiveFrom'] ?? '');
            $entity['deepInactive'] = false;
            $entity['lastSeen'] = $today;
            $entity['missingSince'] = '';
            $entity['stateBeforeAbsence'] = !empty($base['stateBeforeAbsence']);
            if ($idx === null) {
                $db[$kind][] = $entity;
                $stats['created']++;
                $stats['changed']++;
            } else {
                // Solo cuenta como cambio real si varían los datos de la ficha,
                // no la fecha de último avistamiento del ciclo de inactividad.
                $compare = static function (array $a, array $b): bool {
                    foreach (['active', 'inactiveFrom', 'deepInactive', 'lastSeen', 'missingSince', 'stateBeforeAbsence', 'partnerPendingId', 'partnerBrokenAt'] as $field) {
                        unset($a[$field], $b[$field]);
                    }
                    foreach ($a as $field => $value) {
                        if ($value === null) $a[$field] = '';
                    }
                    foreach ($b as $field => $value) {
                        if ($value === null) $b[$field] = '';
                    }
                    return $a == $b;
                };
                if (!$compare($existing, $entity)) {
                    $stats['changed']++;
                }
                $db[$kind][$idx] = $entity;
                if (!$reactivated && !$deactivated) {
                    $stats['updated']++;
                }
            }
        }

        if ($kind === 'drivers') {
            self::restorePendingPairings($db, $today);
        }
        if ($kind === 'shifts') {
            usort($db[$kind], static fn($a, $b) => (int)$a['code'] <=> (int)$b['code']);
            $db['needs'] = self::calculateNeeds($db);
        }
        return ['db' => $db, 'stats' => $stats];
    }

    private static function driverFromCsvRow(array $row, array $existing, string $today): array
    {
        $has = static fn(string $k): bool => self::csvHas($row, $k);
        $id = self::csvText($row['id'] ?? '', 32);
        $firstName = $has('firstName') ? self::csvText($row['firstName'], 60) : (string)($existing['firstName'] ?? '');
        $lastName = $has('lastName') ? self::csvText($row['lastName'], 80) : (string)($existing['lastName'] ?? '');
        $name = $has('name') ? self::csvText($row['name'], 120) : (string)($existing['name'] ?? '');
        if ($name === '') {
            $name = trim($firstName . ' ' . $lastName);
        }
        $fuels = $has('authorizedFuels') ? [] : array_values(array_map('strval', (array)($existing['authorizedFuels'] ?? [])));
        if ($has('authorizedFuels')) {
            foreach (preg_split('/[|;]/', (string)$row['authorizedFuels']) ?: [] as $fuel) {
                $fuel = self::csvText($fuel, 30);
                if ($fuel !== '' && !in_array($fuel, $fuels, true)) {
                    $fuels[] = $fuel;
                }
            }
        }
        $role = $has('role') ? self::csvText($row['role'], 40) : (string)($existing['role'] ?? 'Conductor');
        $group = $has('group') ? strtoupper(self::csvText($row['group'], 2)) : (string)($existing['group'] ?? '');
        $active = $has('active') ? self::csvBool($row['active'], true) : (bool)($existing['active'] ?? true);
        return [
            'id' => $id,
            'name' => $name,
            'firstName' => $firstName,
            'lastName' => $lastName,
            'role' => $role !== '' ? $role : 'Conductor',
            'active' => $active,
            'phone' => $has('phone') ? self::csvText($row['phone'], 40) : (string)($existing['phone'] ?? ''),
            'license' => $has('license') ? self::csvText($row['license'], 20) : (string)($existing['license'] ?? ''),
            'since' => $has('since') ? self::csvText($row['since'], 10) : (string)($existing['since'] ?? ''),
            'notes' => $has('notes') ? self::csvText($row['notes'], 500) : (string)($existing['notes'] ?? ''),
            'authorizedFuels' => $fuels,
            'maxVehicleSize' => $has('maxVehicleSize') ? max(0, min(100, (int)$row['maxVehicleSize'])) : (int)($existing['maxVehicleSize'] ?? 0),
            'allowsArticulated' => $has('allowsArticulated') ? self::csvBool($row['allowsArticulated']) : (bool)($existing['allowsArticulated'] ?? false),
            'group' => in_array($group, ['A', 'B'], true) ? $group : '',
            'partnerId' => (string)($existing['partnerId'] ?? ''),
            'partnerPendingId' => (string)($existing['partnerPendingId'] ?? ''),
            'partnerBrokenAt' => (string)($existing['partnerBrokenAt'] ?? ''),
        ];
    }

    private static function vehicleFromCsvRow(array $row, array $existing, array $db): array
    {
        $has = static fn(string $k): bool => self::csvHas($row, $k);
        $typeId = $has('typeId') ? self::csvText($row['typeId'], 40) : (string)($existing['typeId'] ?? '');
        if ($typeId !== '' && !self::findVehicleSubtype($db, $typeId)) {
            $typeId = '';
        }
        $previousStatus = (string)($existing['status'] ?? 'disponible');
        $status = $has('status')
            ? self::csvVehicleStatus((string)$row['status'], $previousStatus)
            : $previousStatus;
        $kind = $has('kind')
            ? (self::csvSlug((string)$row['kind']) === 'articulado' ? 'articulado' : self::csvText($row['kind'], 30))
            : (string)($existing['kind'] ?? 'urbano');
        return [
            'id' => self::csvText($row['id'] ?? '', 32),
            'plate' => $has('plate') ? self::csvText($row['plate'], 20) : (string)($existing['plate'] ?? ''),
            'model' => $has('model') ? self::csvText($row['model'], 80) : (string)($existing['model'] ?? ''),
            'kind' => $kind,
            'typeId' => $typeId,
            'photo' => (string)($existing['photo'] ?? ''),
            'status' => $status,
            'km' => $has('km') ? self::csvInt($row['km'], (int)($existing['km'] ?? 0)) : (int)($existing['km'] ?? 0),
            'since' => $has('since') ? self::csvText($row['since'], 10) : (string)($existing['since'] ?? ''),
            'notes' => $has('notes') ? self::csvText($row['notes'], 500) : (string)($existing['notes'] ?? ''),
        ];
    }

    private static function shiftFromCsvRow(array $row, array $existing): ?array
    {
        $has = static fn(string $k): bool => self::csvHas($row, $k);
        $code = (int)($row['code'] ?? 0);
        $label = $has('label') ? self::csvText($row['label'], 20) : (string)($existing['label'] ?? ('T' . str_pad((string)$code, 2, '0', STR_PAD_LEFT)));
        $line = $has('line') ? self::csvText($row['line'], 20) : (string)($existing['line'] ?? 'REF');
        $lineLabel = $has('lineLabel') ? self::csvText($row['lineLabel'], 120) : (string)($existing['lineLabel'] ?? $line);
        $vehicle = $has('vehicle') ? self::csvText($row['vehicle'], 20) : (string)($existing['vehicle'] ?? '');
        $variants = [];
        foreach (['lv', 'sab', 'dom'] as $kind) {
            $start = $has($kind . '_start') ? self::csvText($row[$kind . '_start'], 5) : '';
            $end = $has($kind . '_end') ? self::csvText($row[$kind . '_end'], 5) : '';
            if ($start !== '' || $end !== '') {
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
                $variantLine = $has($kind . '_line') ? self::csvText($row[$kind . '_line'], 20) : $line;
                $variantLabel = $has($kind . '_lineLabel') ? self::csvText($row[$kind . '_lineLabel'], 120) : $lineLabel;
                $variants[$kind] = [
                    'start' => $start,
                    'end' => $end,
                    'startMin' => $startMin,
                    'endMin' => $endMin,
                    'hours' => round($duration / 60, 2),
                    'line' => $variantLine !== '' ? $variantLine : $line,
                    'lineLabel' => $variantLabel !== '' ? $variantLabel : $lineLabel,
                    'vehicle' => $has($kind . '_vehicle') ? (self::csvText($row[$kind . '_vehicle'], 20) ?: null) : ($vehicle !== '' ? $vehicle : null),
                ];
            } elseif (isset($existing['variants'][$kind]) && is_array($existing['variants'][$kind])) {
                $variants[$kind] = $existing['variants'][$kind];
            }
        }
        if (!$variants) {
            return null;
        }
        $first = $variants['lv'] ?? reset($variants);
        return [
            'code' => $code,
            'label' => $label !== '' ? $label : ('T' . str_pad((string)$code, 2, '0', STR_PAD_LEFT)),
            'line' => (string)($first['line'] ?? $line),
            'lineLabel' => (string)($first['lineLabel'] ?? $lineLabel),
            'vehicle' => $first['vehicle'] ?? ($vehicle !== '' ? $vehicle : null),
            'variants' => $variants,
        ];
    }

    /** @param array<string,mixed> $db */
    public function write(array $db): void
    {
        $tmp = $this->dbFile . '.tmp.' . getmypid();
        $json = json_encode($db, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        if ($json === false) {
            throw new RuntimeException('No se pudo serializar el estado.');
        }
        if (file_put_contents($tmp, $json) === false) {
            throw new RuntimeException('No se pudo escribir el estado.');
        }
        if (!@rename($tmp, $this->dbFile)) {
            @unlink($tmp);
            throw new RuntimeException('No se pudo guardar el estado.');
        }
        $this->db = $db;
    }

    public function reset(?string $month = null): array
    {
        if ($month === null || $month === '') {
            $seed = $this->seed();
            $this->write($seed);
            // Recarga para que normalise() recalcule las necesidades desde los turnos.
            $this->db = null;
        } else {
            $db = $this->load();
            if (!isset($db['assignments']) || !is_array($db['assignments'])) {
                $db['assignments'] = [];
            }
            // Solo se borran turnos y descansos. Las ausencias se mantienen y
            // sus celdas se reconstruyen desde los registros del mes.
            $keep = [];
            foreach ((array)($db['assignments'][$month] ?? []) as $key => $value) {
                $value = self::normaliseStatusValue((string)$value);
                if (in_array($value, self::ABSENCE_CODES, true)) {
                    $keep[$key] = $value;
                }
            }
            foreach (self::monthAbsenceCells($db, $month) as $key => $value) {
                $keep[$key] = $value;
            }
            $db['assignments'][$month] = $keep;
            $db['vehicleAssignments'][$month] = [];
            $this->write($db);
        }
        return $this->load();
    }

    private static function overlapsMonth(array $absence, string $month): bool
    {
        $from = (string)($absence['from'] ?? '');
        $to = (string)($absence['to'] ?? '');
        if ($from === '' || $to === '') {
            return false;
        }
        $start = $month . '-01';
        $end = date('Y-m-t', strtotime($start . ' 00:00:00'));
        return $from <= $end && $to >= $start;
    }

    /** Celdas de ausencia que deben sobrevivir a la limpieza de un mes. */
    private static function monthAbsenceCells(array $db, string $month): array
    {
        $cells = [];
        $start = $month . '-01';
        $end = date('Y-m-t', strtotime($start . ' 00:00:00'));
        foreach ((array)($db['absences'] ?? []) as $absence) {
            if (!self::overlapsMonth($absence, $month)) {
                continue;
            }
            $from = max($start, (string)($absence['from'] ?? ''));
            $to = min($end, (string)($absence['to'] ?? ''));
            if ($from > $to) {
                continue;
            }
            $type = self::normaliseStatusValue((string)($absence['type'] ?? 'VA'));
            if (!in_array($type, self::ABSENCE_CODES, true)) {
                continue;
            }
            $driverId = (string)($absence['driverId'] ?? '');
            if ($driverId === '') {
                continue;
            }
            $cursor = strtotime($from . ' 00:00:00');
            $last = strtotime($to . ' 00:00:00');
            while ($cursor !== false && $cursor <= $last) {
                $cells[$driverId . '|' . date('Y-m-d', $cursor)] = $type;
                $cursor = strtotime('+1 day', $cursor);
            }
        }
        return $cells;
    }

    /** Completa estructuras por si el archivo es antiguo o está incompleto. */
    private function normalise(): void
    {
        $db = &$this->db;
        $today = date('Y-m-d');
        $db['version'] = 1;
        foreach (['drivers' => [], 'vehicles' => [], 'vehicleTypes' => [], 'shifts' => [], 'lines' => [], 'holidays' => [], 'absences' => [], 'assignments' => [], 'vehicleAssignments' => []] as $k => $default) {
            if (!isset($db[$k]) || !is_array($db[$k])) {
                $db[$k] = $default;
            }
        }
        if (!isset($db['settings']) || !is_array($db['settings'])) {
            $db['settings'] = ['currentMonth' => date('Y-m'), 'maxConsecutive' => 5, 'minRest' => 12];
        }
        $db['settings']['exceptionDays'] = max(0, min(14, (int)($db['settings']['exceptionDays'] ?? 6)));
        $db['settings']['exceptionRest'] = max(1, min(168, (int)($db['settings']['exceptionRest'] ?? 48)));
        $db['settings']['minRest'] = max(0, min(24, (int)($db['settings']['minRest'] ?? 12)));
        $db['settings']['reducedRestMin'] = max(1, min(24, (int)($db['settings']['reducedRestMin'] ?? 9)));
        $db['settings']['maxReducedRests'] = max(0, min(14, (int)($db['settings']['maxReducedRests'] ?? 3)));
        $freeDays = [];
        foreach ((array)($db['settings']['freeDaysByMonth'] ?? []) as $month => $value) {
            if (preg_match('/^\d{4}-(0[1-9]|1[0-2])$/', (string)$month)) {
                $freeDays[(string)$month] = max(0, min(count(self::monthDays((string)$month)), (int)$value));
            }
        }
        $db['settings']['freeDaysByMonth'] = $freeDays;
        // Códigos de ausencia: VA, BA, AP, PI/PC/PF, HS y HR (horas registro).
        foreach ($db['absences'] as &$absence) {
            $type = self::normaliseStatusValue((string)($absence['type'] ?? 'VA'));
            $absence['type'] = in_array($type, self::ABSENCE_CODES, true) ? $type : 'VA';
        }
        unset($absence);
        foreach ($db['assignments'] as &$rows) {
            if (!is_array($rows)) {
                $rows = [];
                continue;
            }
            foreach ($rows as &$value) {
                $value = self::normaliseStatusValue((string)$value);
            }
            unset($value);
        }
        unset($rows);
        // Catálogo de ejemplo solo la primera vez; si el usuario lo vacía, se respeta.
        if (empty($db['settings']['vehicleTypesInitialized'])) {
            $db['vehicleTypes'] = self::defaultVehicleTypes();
            $db['settings']['vehicleTypesInitialized'] = true;
        }
        // Autorizaciones de conductores: combustibles permitidos y tope de metros.
        foreach ($db['drivers'] as &$driver) {
            $fuels = [];
            foreach ((array)($driver['authorizedFuels'] ?? []) as $fuel) {
                $fuel = trim((string)$fuel);
                if ($fuel !== '' && !in_array($fuel, $fuels, true)) {
                    $fuels[] = $fuel;
                }
            }
            $driver['authorizedFuels'] = $fuels;
            $driver['maxVehicleSize'] = max(0, min(100, (int)($driver['maxVehicleSize'] ?? 0)));
            $driver['allowsArticulated'] = !empty($driver['allowsArticulated']);
            $group = strtoupper(trim((string)($driver['group'] ?? '')));
            $driver['group'] = in_array($group, ['A', 'B'], true) ? $group : '';
            $partner = trim((string)($driver['partnerId'] ?? ''));
            $driver['partnerId'] = ($partner !== '' && $partner !== (string)($driver['id'] ?? '')) ? $partner : '';
            $pending = trim((string)($driver['partnerPendingId'] ?? ''));
            $driver['partnerPendingId'] = ($pending !== '' && $pending !== (string)($driver['id'] ?? '')) ? $pending : '';
            $broken = trim((string)($driver['partnerBrokenAt'] ?? ''));
            $driver['partnerBrokenAt'] = self::validDate($broken) ? $broken : '';
            if ($driver['partnerPendingId'] === '' || self::daysSince($driver['partnerBrokenAt'], $today) >= self::INACTIVE_DAYS) {
                $driver['partnerPendingId'] = '';
                $driver['partnerBrokenAt'] = '';
            }
            unset($driver['authorizedTypes']);
            self::normaliseLifecycle($driver, $today);
        }
        unset($driver);
        foreach ($db['vehicles'] as &$vehicle) {
            if (is_array($vehicle)) {
                self::normaliseLifecycle($vehicle, $today);
            }
        }
        unset($vehicle);
        foreach ($db['shifts'] as &$shift) {
            if (is_array($shift)) {
                self::normaliseLifecycle($shift, $today);
            }
        }
        unset($shift);
        self::restorePendingPairings($db, $today);
        // Restricciones de combustible y tamaño por línea.
        foreach ($db['lines'] as &$line) {
            $fuelMode = (string)($line['fuelMode'] ?? 'all');
            $line['fuelMode'] = in_array($fuelMode, ['all', 'only', 'deny'], true) ? $fuelMode : 'all';
            $line['fuelValues'] = array_values(array_unique(array_filter(
                array_map('strval', (array)($line['fuelValues'] ?? [])),
                static fn($v) => $v !== ''
            )));
            $sizeMode = (string)($line['sizeMode'] ?? 'all');
            $line['sizeMode'] = in_array($sizeMode, ['all', 'only', 'max'], true) ? $sizeMode : 'all';
            $line['sizeValues'] = array_values(array_unique(array_map('intval', (array)($line['sizeValues'] ?? []))));
            $line['maxSize'] = max(0, min(100, (int)($line['maxSize'] ?? 0)));
        }
        unset($line);
        // Las necesidades nunca se guardan a mano: se derivan del catálogo de turnos.
        $db['needs'] = self::calculateNeeds($db);
    }

    /**
     * Rompe la pareja de quien apuntaba a un conductor dado de baja, pero deja
     * intacto su grupo A/B y recuerda la pareja para restaurarla si reaparece.
     */
    public static function breakPairingsFor(array &$db, string $partnerId, string $today): void
    {
        if (!isset($db['drivers']) || !is_array($db['drivers'])) {
            return;
        }
        foreach ($db['drivers'] as &$driver) {
            if ((string)($driver['partnerId'] ?? '') === $partnerId) {
                $driver['partnerPendingId'] = $partnerId;
                $driver['partnerBrokenAt'] = $today;
                $driver['partnerId'] = '';
            }
        }
        unset($driver);
    }

    /** Rehace las parejas rotas cuyo compañero vuelve antes de 40 días. */
    public static function restorePendingPairings(array &$db, string $today): void
    {
        if (!isset($db['drivers']) || !is_array($db['drivers'])) {
            return;
        }
        $byId = [];
        foreach ($db['drivers'] as $driver) {
            $byId[(string)($driver['id'] ?? '')] = $driver;
        }
        foreach ($db['drivers'] as &$driver) {
            $pending = (string)($driver['partnerPendingId'] ?? '');
            if ($pending === '') {
                continue;
            }
            $broken = (string)($driver['partnerBrokenAt'] ?? '');
            if ($broken !== '' && self::daysSince($broken, $today) >= self::INACTIVE_DAYS) {
                $driver['partnerPendingId'] = '';
                $driver['partnerBrokenAt'] = '';
                continue;
            }
            $other = $byId[$pending] ?? null;
            if (!$other || empty($other['active']) || !empty($other['deepInactive']) || (string)($other['partnerId'] ?? '') !== '') {
                continue;
            }
            $driver['partnerId'] = $pending;
            $driver['partnerPendingId'] = '';
            $driver['partnerBrokenAt'] = '';
            $group = strtoupper(trim((string)($driver['group'] ?? '')));
            if (in_array($group, ['A', 'B'], true)) {
                foreach ($db['drivers'] as &$companion) {
                    if ((string)($companion['id'] ?? '') === $pending) {
                        $companion['group'] = $group === 'A' ? 'B' : 'A';
                        $companion['partnerId'] = (string)($driver['id'] ?? '');
                        $companion['partnerPendingId'] = '';
                        $companion['partnerBrokenAt'] = '';
                        break;
                    }
                }
                unset($companion);
            }
        }
        unset($driver);
        self::normalisePairings($db);
    }

    /** Conserva solo parejas mutuas y con ambos conductores presentes. */
    public static function normalisePairings(array &$db): void
    {
        if (!isset($db['drivers']) || !is_array($db['drivers'])) {
            return;
        }
        $exists = [];
        foreach ($db['drivers'] as $driver) {
            if (empty($driver['deepInactive'])) {
                $exists[(string)($driver['id'] ?? '')] = true;
            }
        }
        $links = [];
        foreach ($db['drivers'] as $driver) {
            $id = (string)($driver['id'] ?? '');
            if ($id === '') {
                continue;
            }
            $partner = trim((string)($driver['partnerId'] ?? ''));
            $links[$id] = (empty($driver['deepInactive']) && $partner !== '' && $partner !== $id && isset($exists[$partner])) ? $partner : '';
        }
        foreach ($links as $id => $partner) {
            if ($partner !== '' && (string)($links[$partner] ?? '') !== (string)$id) {
                $links[$id] = '';
            }
        }
        $groups = [];
        foreach ($db['drivers'] ?? [] as $driver) {
            $id = (string)($driver['id'] ?? '');
            $group = strtoupper(trim((string)($driver['group'] ?? '')));
            $groups[$id] = in_array($group, ['A', 'B'], true) ? $group : '';
        }
        foreach ($links as $id => $partner) {
            if ($partner === '' || strcmp((string)$id, (string)$partner) >= 0) {
                continue;
            }
            $groupA = $groups[(string)$id] ?? '';
            $groupB = $groups[(string)$partner] ?? '';
            if ($groupA !== '' && $groupB !== ($groupA === 'A' ? 'B' : 'A')) {
                $groups[(string)$partner] = $groupA === 'A' ? 'B' : 'A';
            } elseif ($groupB !== '' && $groupA !== ($groupB === 'A' ? 'B' : 'A')) {
                $groups[(string)$id] = $groupB === 'A' ? 'B' : 'A';
            }
        }
        if (!isset($db['drivers']) || !is_array($db['drivers'])) {
            return;
        }
        foreach ($db['drivers'] as &$driver) {
            $id = (string)($driver['id'] ?? '');
            $driver['partnerId'] = $links[$id] ?? '';
            $driver['group'] = $groups[$id] ?? '';
        }
        unset($driver);
    }

    /**
     * Guarda el grupo y el compañero de un conductor. La pareja siempre queda
     * simétrica: si el nuevo compañero tenía otra pareja, esta se deshace.
     *
     * @return array<string,mixed> base actualizada
     */
    public static function setDriverPairing(array $db, string $driverId, string $group, string $partnerId): array
    {
        $driverId = trim($driverId);
        $group = strtoupper(trim($group));
        if (!in_array($group, ['A', 'B', ''], true)) {
            $group = '';
        }
        $ids = array_map('strval', array_column($db['drivers'] ?? [], 'id'));
        $exists = array_fill_keys($ids, true);
        $partnerId = trim($partnerId);
        if ($partnerId === '' || $partnerId === $driverId || !isset($exists[$partnerId])) {
            $partnerId = '';
        }
        // En una pareja fija, el compañero toma el grupo opuesto: A mañana,
        // B tarde. Si no se elige grupo, se respeta el que ya tuviera.
        $partnerGroup = ($partnerId !== '' && $group !== '') ? ($group === 'A' ? 'B' : 'A') : '';
        $found = false;
        foreach ($db['drivers'] as &$driver) {
            if ((string)($driver['id'] ?? '') === $driverId) {
                $driver['group'] = $group;
                $driver['partnerId'] = $partnerId;
                $found = true;
                break;
            }
        }
        unset($driver);
        if (!$found) {
            return $db;
        }

        $links = [];
        foreach ($db['drivers'] as $driver) {
            $id = (string)($driver['id'] ?? '');
            if ($id === '') {
                continue;
            }
            $partner = trim((string)($driver['partnerId'] ?? ''));
            $links[$id] = ($partner !== '' && $partner !== $id && isset($exists[$partner])) ? $partner : '';
        }
        $links[$driverId] = $partnerId;
        // Si el conductor cambiaba de pareja, la anterior deja de apuntar a él.
        foreach ($links as $id => $partner) {
            if ($partner === $driverId && $id !== $partnerId) {
                $links[$id] = '';
            }
        }
        if ($partnerId !== '') {
            $oldPartner = $links[$partnerId] ?? '';
            $links[$partnerId] = $driverId;
            if ($oldPartner !== '' && $oldPartner !== $driverId && ($links[$oldPartner] ?? '') === $partnerId) {
                $links[$oldPartner] = '';
            }
        }
        foreach ($db['drivers'] as &$driver) {
            $id = (string)($driver['id'] ?? '');
            $partner = $links[$id] ?? '';
            $driver['partnerId'] = ($partner !== '' && ($links[$partner] ?? '') === $id) ? $partner : '';
            if ($id === $partnerId && $partnerGroup !== '') {
                $driver['group'] = $partnerGroup;
            }
        }
        unset($driver);
        return $db;
    }

    /* ------------------------------------------------------------------ */
    /* Consultas                                                          */
    /* ------------------------------------------------------------------ */

    public static function dayType(string $date, array $holidays): string
    {
        foreach ($holidays as $h) {
            $d = is_array($h) ? (string)($h['date'] ?? '') : (string)$h;
            if ($d === $date) {
                return 'dom';
            }
        }
        $w = (int)(new DateTimeImmutable($date))->format('N'); // 1..7
        if ($w === 7) {
            return 'dom';
        }
        if ($w === 6) {
            return 'sab';
        }
        return 'lv';
    }

    /** Indica si un mes ya tiene turnos asignados (no solo descansos o ausencias). */
    public static function monthHasAssignments(array $db, string $month): bool
    {
        foreach ((array)($db['assignments'][$month] ?? []) as $code) {
            if (ctype_digit((string)$code)) {
                return true;
            }
        }
        return false;
    }

    /** @return list<string> fechas del mes */
    public static function monthDays(string $month): array
    {
        [$y, $m] = array_map('intval', explode('-', $month));
        $days = [];
        $cur = new DateTimeImmutable(sprintf('%04d-%02d-01', $y, $m));
        $end = $cur->modify('last day of this month');
        while ($cur <= $end) {
            $days[] = $cur->format('Y-m-d');
            $cur = $cur->modify('+1 day');
        }
        return $days;
    }

    /** @return list<int> códigos válidos para el tipo de día */
    public static function validCodes(array $shifts, string $kind): array
    {
        $codes = [];
        foreach ($shifts as $s) {
            if (!empty($s['deepInactive']) || (array_key_exists('active', $s) && empty($s['active']))) {
                continue;
            }
            if (isset($s['variants'][$kind]) && isset($s['code'])) {
                $codes[] = (int)$s['code'];
            }
        }
        sort($codes);
        return $codes;
    }

    /**
     * Necesidades diarias calculadas desde los turnos que existen.
     *
     * Un turno cuenta para un tipo de día cuando tiene una variante válida para
     * ese tipo. Así, al dar de alta, editar o borrar un turno, la necesidad se
     * ajusta sola y no hay campos editables que se queden desactualizados.
     * Los turnos archivados (deepInactive) no cuentan; los inactivos sí, porque
     * siguen visibles y pueden aparecer en cuadrantes ya asignados.
     *
     * @return array{lv:int,sab:int,dom:int}
     */
    public static function calculateNeeds(array $db): array
    {
        $shifts = $db['shifts'] ?? [];
        $needs = ['lv' => 0, 'sab' => 0, 'dom' => 0];
        if (!is_array($shifts)) {
            return $needs;
        }

        foreach ($shifts as $shift) {
            if (!is_array($shift)) {
                continue;
            }
            // Solo los turnos archivados dejan de generar necesidad. Un turno
            // «inactivo» sigue visible y puede tener asignaciones en cuadrantes,
            // así que debe seguir contando hasta que se archive definitivamente.
            if (!empty($shift['deepInactive'])) {
                continue;
            }
            $variants = $shift['variants'] ?? null;
            if (!is_array($variants)) {
                continue;
            }
            foreach (['lv', 'sab', 'dom'] as $kind) {
                if (isset($variants[$kind]) && is_array($variants[$kind])) {
                    $needs[$kind]++;
                }
            }
        }

        return $needs;
    }

    /**
     * Catálogo inicial de modelos y variantes. Se aplica solo cuando la base de
     * datos no tiene todavía catálogo propio.
     *
     * @return list<array<string,mixed>>
     */
    public static function defaultVehicleTypes(): array
    {
        return [
            [
                'id' => 'vt_citaro',
                'brand' => 'Mercedes-Benz',
                'model' => 'Citaro',
                'name' => 'Mercedes-Benz Citaro',
                'description' => 'Autobús urbano de piso bajo.',
                'active' => true,
                'variants' => [
                    ['id' => 'vts_citaro_09_diesel', 'size' => '9 m', 'fuel' => 'Gasoil', 'label' => '9 m · Gasoil', 'description' => '', 'active' => true],
                    ['id' => 'vts_citaro_12_diesel', 'size' => '12 m', 'fuel' => 'Gasoil', 'label' => '12 m · Gasoil', 'description' => '', 'active' => true],
                    ['id' => 'vts_citaro_12_electric', 'size' => '12 m', 'fuel' => 'Eléctrico', 'label' => '12 m · Eléctrico', 'description' => '', 'active' => true],
                    ['id' => 'vts_citaro_15_cng', 'size' => '15 m', 'fuel' => 'GNC (gas)', 'label' => '15 m · GNC (gas)', 'description' => '', 'active' => true],
                ],
            ],
            [
                'id' => 'vt_lions_city',
                'brand' => 'MAN',
                'model' => "Lion's City",
                'name' => "MAN Lion's City",
                'description' => 'Autobús urbano modular.',
                'active' => true,
                'variants' => [
                    ['id' => 'vts_lions_12_diesel', 'size' => '12 m', 'fuel' => 'Gasoil', 'label' => '12 m · Gasoil', 'description' => '', 'active' => true],
                    ['id' => 'vts_lions_18_cng', 'size' => '18 m', 'fuel' => 'GNC (gas)', 'label' => '18 m · GNC (gas)', 'description' => '', 'active' => true],
                ],
            ],
        ];
    }

    /** @return array<string,mixed>|null */
    public static function findVehicleSubtype(array $db, string $id): ?array
    {
        if ($id === '') {
            return null;
        }
        foreach ($db['vehicleTypes'] ?? [] as $type) {
            foreach ($type['variants'] ?? [] as $variant) {
                if ((string)($variant['id'] ?? '') === $id) {
                    return $variant;
                }
            }
        }
        return null;
    }

    /** @return array<string,mixed>|null */
    public static function findVehicleTypeOfSubtype(array $db, string $id): ?array
    {
        foreach ($db['vehicleTypes'] ?? [] as $type) {
            foreach ($type['variants'] ?? [] as $variant) {
                if ((string)($variant['id'] ?? '') === $id) {
                    return $type;
                }
            }
        }
        return null;
    }

    public static function vehicleTypeLabel(array $db, ?string $id): string
    {
        $variant = self::findVehicleSubtype($db, (string)$id);
        if (!$variant) {
            return '';
        }
        $type = self::findVehicleTypeOfSubtype($db, (string)$id);
        $parts = [];
        if ($type) {
            $parts[] = trim((string)($type['brand'] ?? '') . ' ' . (string)($type['model'] ?? ''));
        }
        if ((string)($variant['size'] ?? '') !== '') {
            $parts[] = (string)$variant['size'];
        }
        if ((string)($variant['fuel'] ?? '') !== '') {
            $parts[] = (string)$variant['fuel'];
        }
        return implode(' · ', array_filter($parts, static fn($p) => $p !== ''));
    }

    /** Extrae los metros de una medida como «12 m» o «12,5 m». */
    public static function sizeMeters(mixed $size): ?float
    {
        $s = trim((string)$size);
        if ($s === '' || !preg_match('/(\d+(?:[.,]\d+)?)\s*m/i', $s, $m)) {
            return null;
        }
        return (float)str_replace(',', '.', $m[1]);
    }

    /** @return list<string> combustibles presentes en el catálogo */
    public static function vehicleFuels(array $db): array
    {
        $fuels = [];
        foreach ($db['vehicleTypes'] ?? [] as $type) {
            foreach ($type['variants'] ?? [] as $variant) {
                $fuel = trim((string)($variant['fuel'] ?? ''));
                if ($fuel !== '' && !in_array($fuel, $fuels, true)) {
                    $fuels[] = $fuel;
                }
            }
        }
        sort($fuels, SORT_STRING);
        return $fuels;
    }

    /** @return list<int> tamaños en metros presentes en el catálogo */
    public static function vehicleSizes(array $db): array
    {
        $sizes = [];
        foreach ($db['vehicleTypes'] ?? [] as $type) {
            foreach ($type['variants'] ?? [] as $variant) {
                $meters = self::sizeMeters($variant['size'] ?? '');
                if ($meters !== null && $meters > 0) {
                    $sizes[(int)ceil($meters)] = true;
                }
            }
        }
        $result = array_map('intval', array_keys($sizes));
        sort($result, SORT_NUMERIC);
        return $result;
    }

    /**
     * Un conductor puede conducir una variante si su combustible está entre los
     * autorizados y su tamaño no supera el tope. La marca y el modelo no influyen.
     */
    public static function driverCanDrive(array $driver, array $db, array $vehicle): bool
    {
        $variant = self::findVehicleSubtype($db, (string)($vehicle['typeId'] ?? ''));
        if (!$variant) {
            // Vehículos antiguos sin tipo de catálogo: no se puede comprobar, se respeta.
            return true;
        }
        $fuel = trim((string)($variant['fuel'] ?? ''));
        $fuels = array_map('strval', (array)($driver['authorizedFuels'] ?? []));
        if ($fuel === '' || !in_array($fuel, $fuels, true)) {
            return false;
        }
        $meters = self::sizeMeters($variant['size'] ?? '');
        $articulated = (string)($vehicle['kind'] ?? '') === 'articulado' || ($meters !== null && $meters >= 18);
        if ($articulated) {
            // Los articulados no se heredan del tope de metros: van aparte.
            return !empty($driver['allowsArticulated']);
        }
        $max = (int)($driver['maxVehicleSize'] ?? 0);
        return $max > 0 && $meters !== null && $meters <= $max;
    }

    /** Comprueba las reglas de combustible y tamaño de una línea. */
    public static function lineAllowsVehicle(array $db, array $line, array $vehicle): bool
    {
        $variant = self::findVehicleSubtype($db, (string)($vehicle['typeId'] ?? ''));
        if (!$variant) {
            // Sin tipo de catálogo no hay nada que comprobar.
            return true;
        }
        $fuel = trim((string)($variant['fuel'] ?? ''));
        $fuelMode = (string)($line['fuelMode'] ?? 'all');
        $fuelValues = array_map('strval', (array)($line['fuelValues'] ?? []));
        if ($fuel !== '') {
            if ($fuelMode === 'only' && !in_array($fuel, $fuelValues, true)) {
                return false;
            }
            if ($fuelMode === 'deny' && in_array($fuel, $fuelValues, true)) {
                return false;
            }
        }
        $meters = self::sizeMeters($variant['size'] ?? '');
        if ($meters === null) {
            return true;
        }
        $sizeMode = (string)($line['sizeMode'] ?? 'all');
        $sizeValues = array_map('intval', (array)($line['sizeValues'] ?? []));
        if ($sizeMode === 'only' && !in_array((int)ceil($meters), $sizeValues, true)) {
            return false;
        }
        if ($sizeMode === 'max' && (int)($line['maxSize'] ?? 0) > 0 && $meters > (int)$line['maxSize']) {
            return false;
        }
        return true;
    }

    /** Índices ligeros para no copiar la base completa en cada servicio. */
    public static function vehicleContext(array $db): array
    {
        $subtypes = [];
        foreach ($db['vehicleTypes'] ?? [] as $type) {
            foreach ($type['variants'] ?? [] as $variant) {
                $subtypes[(string)($variant['id'] ?? '')] = $variant;
            }
        }
        $vehicles = [];
        foreach ($db['vehicles'] ?? [] as $vehicle) {
            $id = (string)($vehicle['id'] ?? '');
            if ($id !== '' && empty($vehicle['deepInactive']) && ($vehicle['active'] ?? true) !== false) {
                $vehicles[$id] = $vehicle;
            }
        }
        $lines = [];
        foreach ($db['lines'] ?? [] as $line) {
            $lines[(string)($line['code'] ?? '')] = $line;
        }
        $shifts = [];
        foreach ($db['shifts'] ?? [] as $shift) {
            if (!empty($shift['deepInactive']) || ($shift['active'] ?? true) === false) {
                continue;
            }
            $shifts[(int)($shift['code'] ?? 0)] = $shift;
        }
        return [
            'vehicles' => $vehicles,
            'subtypes' => $subtypes,
            'lines' => $lines,
            'shifts' => $shifts,
            'holidays' => (array)($db['holidays'] ?? []),
        ];
    }

    /** @return array{0:int,1:int} */
    private static function variantMinutes(array $variant): array
    {
        $start = (int)($variant['startMin'] ?? 0);
        $end = (int)($variant['endMin'] ?? $start);
        if ($end <= $start) {
            $end += 1440;
        }
        return [$start, $end];
    }

    /** Autorización del conductor y restricciones de línea usando índices ya listos. */
    private static function vehicleIsSuitable(array $ctx, array $driver, array $vehicle, string $lineCode): bool
    {
        $variant = $ctx['subtypes'][(string)($vehicle['typeId'] ?? '')] ?? null;
        if (!$variant) {
            return true; // Bus antiguo sin tipo: no se puede comprobar, se respeta.
        }
        $fuel = trim((string)($variant['fuel'] ?? ''));
        $fuels = array_map('strval', (array)($driver['authorizedFuels'] ?? []));
        if ($fuel === '' || !in_array($fuel, $fuels, true)) {
            return false;
        }
        $meters = self::sizeMeters($variant['size'] ?? '');
        $articulated = (string)($vehicle['kind'] ?? '') === 'articulado' || ($meters !== null && $meters >= 18);
        if ($articulated) {
            return !empty($driver['allowsArticulated']);
        }
        $max = (int)($driver['maxVehicleSize'] ?? 0);
        if ($max <= 0 || $meters === null || $meters > $max) {
            return false;
        }
        $line = $ctx['lines'][$lineCode] ?? null;
        if (!$line) {
            return true;
        }
        $fuelMode = (string)($line['fuelMode'] ?? 'all');
        $fuelValues = array_map('strval', (array)($line['fuelValues'] ?? []));
        if ($fuelMode === 'only' && !in_array($fuel, $fuelValues, true)) {
            return false;
        }
        if ($fuelMode === 'deny' && in_array($fuel, $fuelValues, true)) {
            return false;
        }
        if ($meters !== null) {
            $sizeMode = (string)($line['sizeMode'] ?? 'all');
            $sizeValues = array_map('intval', (array)($line['sizeValues'] ?? []));
            if ($sizeMode === 'only' && !in_array((int)ceil($meters), $sizeValues, true)) {
                return false;
            }
            if ($sizeMode === 'max' && (int)($line['maxSize'] ?? 0) > 0 && $meters > (int)$line['maxSize']) {
                return false;
            }
        }
        return true;
    }

    /** Bus previsto para un turno en un tipo de día (el de la variante o el general). */
    public static function shiftVehicleFor(array $shift, string $kind): string
    {
        $vehicle = trim((string)($shift['variants'][$kind]['vehicle'] ?? ''));
        if ($vehicle === '') {
            $vehicle = trim((string)($shift['vehicle'] ?? ''));
        }
        return $vehicle;
    }

    /** Línea efectiva de un turno en un tipo de día. */
    public static function shiftLineFor(array $shift, string $kind): string
    {
        $line = trim((string)($shift['variants'][$kind]['line'] ?? ''));
        if ($line === '') {
            $line = trim((string)($shift['line'] ?? ''));
        }
        return $line;
    }

    /** @return array<string,list<array{0:int,1:int}>> intervalos ocupados por cada bus en una fecha */
    public static function usedVehicleSlots(
        array $ctx,
        string $date,
        array $assignments,
        array $vehicleAssignments,
        ?string $ignoreKey = null
    ): array {
        $suffix = '|' . $date;
        $kind = self::dayType($date, $ctx['holidays']);
        $slots = [];
        foreach ($assignments as $key => $code) {
            if (!is_string($key) || !str_ends_with($key, $suffix) || $key === $ignoreKey || !ctype_digit((string)$code)) {
                continue;
            }
            $shift = $ctx['shifts'][(int)$code] ?? null;
            $variant = $shift['variants'][$kind] ?? null;
            if (!$variant) {
                continue;
            }
            $vehicleId = (string)($vehicleAssignments[$key] ?? self::shiftVehicleFor($shift, $kind));
            if ($vehicleId === '') {
                continue;
            }
            [$start, $end] = self::variantMinutes($variant);
            $slots[$vehicleId][] = [$start, $end];
        }
        return $slots;
    }

    public static function vehicleFreeAt(array $slots, string $vehicleId, int $start, int $end): bool
    {
        foreach ($slots[$vehicleId] ?? [] as [$usedStart, $usedEnd]) {
            if ($start < $usedEnd && $end > $usedStart) {
                return false;
            }
        }
        return true;
    }

    /**
     * Decide qué bus lleva un servicio. Los turnos pares relevan al impar
     * anterior con el mismo bus cuando empiezan después de que aquel termine;
     * si solapan, arrancan un servicio nuevo con otro bus. Si el bus previsto
     * no es apto (autorización, línea o taller), se busca una alternativa.
     *
     * @return array{ok:bool,vehicle:string,reason:string,reassigned:bool}
     */
    public static function chooseServiceVehicle(
        array $ctx,
        array $driver,
        array $shift,
        array $variant,
        int $code,
        string $kind,
        string $date,
        array $assignments,
        array $vehicleAssignments,
        string $ignoreKey,
        ?array $slots = null
    ): array {
        $lineCode = self::shiftLineFor($shift, $kind);
        $desired = self::shiftVehicleFor($shift, $kind);
        $desiredVehicle = $ctx['vehicles'][$desired] ?? null;
        [$start, $end] = self::variantMinutes($variant);
        if ($slots === null) {
            $slots = self::usedVehicleSlots($ctx, $date, $assignments, $vehicleAssignments, $ignoreKey);
        }

        // Relevo: el turno par (2, 4, 6…) continúa con el bus del impar anterior
        // solo si empieza cuando el mañana ya ha terminado.
        $relief = '';
        if ($code > 1 && $code % 2 === 0) {
            $predecessor = $code - 1;
            $previousShift = $ctx['shifts'][$predecessor] ?? null;
            $previousVariant = $previousShift['variants'][$kind] ?? null;
            if ($previousShift && $previousVariant) {
                [, $previousEnd] = self::variantMinutes($previousVariant);
                if ($start >= $previousEnd) {
                    $suffix = '|' . $date;
                    foreach ($assignments as $key => $value) {
                        if (!is_string($key) || !str_ends_with($key, $suffix) || $key === $ignoreKey || (string)$value !== (string)$predecessor) {
                            continue;
                        }
                        $candidate = (string)($vehicleAssignments[$key] ?? self::shiftVehicleFor($previousShift, $kind));
                        if ($candidate !== '' && isset($ctx['vehicles'][$candidate])) {
                            $relief = $candidate;
                            break;
                        }
                    }
                }
            }
        }

        $options = [];
        foreach ($ctx['vehicles'] as $rawId => $vehicle) {
            $id = (string)$rawId;
            if (($vehicle['status'] ?? 'disponible') === 'taller') {
                continue;
            }
            if (!self::vehicleIsSuitable($ctx, $driver, $vehicle, $lineCode)) {
                continue;
            }
            $sameType = $desiredVehicle && (string)($vehicle['typeId'] ?? '') === (string)($desiredVehicle['typeId'] ?? '') && (string)($vehicle['typeId'] ?? '') !== '';
            $isRelief = $relief !== '' && $id === $relief;
            $base = $isRelief ? -1 : ($id === $desired ? 0 : ($sameType ? 1 : 2));
            $busy = !self::vehicleFreeAt($slots, $id, $start, $end);
            $options[] = ['id' => $id, 'score' => $base + ($isRelief ? 0 : ($busy ? 3 : 0))];
        }
        usort($options, static fn($a, $b) => [$a['score'], $a['id']] <=> [$b['score'], $b['id']]);

        if ($options) {
            $chosen = (string)$options[0]['id'];
            return [
                'ok' => true,
                'vehicle' => $chosen,
                'reason' => '',
                'reassigned' => $chosen !== $desired,
            ];
        }

        $reason = 'No hay ningún bus apto y disponible para esta línea';
        if ($desired !== '') {
            if (!$desiredVehicle) {
                $reason = "El bus {$desired} del turno no está en la flota";
            } elseif (($desiredVehicle['status'] ?? 'disponible') === 'taller') {
                $reason = "El bus {$desired} está en taller y no hay alternativa disponible";
            } elseif (!self::vehicleIsSuitable($ctx, $driver, $desiredVehicle, $lineCode)) {
                $reason = "El bus {$desired} no es válido para este conductor o esta línea y no hay alternativa";
            }
        }
        return ['ok' => false, 'vehicle' => '', 'reason' => $reason, 'reassigned' => false];
    }

    /** Horas legibles para los avisos de descanso. */
    private static function hoursLabel(int $minutes): string
    {
        $value = number_format($minutes / 60, 1, ',', '');
        return rtrim(rtrim($value, '0'), ',') . ' h';
    }

    /**
     * Valida el descanso diario en asignaciones manuales con la misma regla que
     * la autoasignación: mínimo normal, reducidos contados desde el último
     * descanso semanal y sin recuperación de horas.
     *
     * @return array{ok:bool,reason:string}
     */
    private static function manualRestCheck(
        array $db, array $assignments, string $driverId, string $date, string $code
    ): array {
        $allByCode = [];
        foreach ($db['shifts'] ?? [] as $shift) {
            $allByCode[(int)($shift['code'] ?? 0)] = $shift;
        }
        $minRest = max(0, (int)($db['settings']['minRest'] ?? 12)) * 60;
        $reducedMin = max(1, min(24, (int)($db['settings']['reducedRestMin'] ?? 9))) * 60;
        $maxReduced = max(0, min(14, (int)($db['settings']['maxReducedRests'] ?? 3)));
        $weeklyRest = max(1, min(168, (int)($db['settings']['exceptionRest'] ?? 48))) * 60;
        $start = new DateTimeImmutable($date);
        $view = array_merge(
            (array)($db['assignments'][$start->modify('-3 months')->format('Y-m')] ?? []),
            (array)($db['assignments'][$start->modify('-2 months')->format('Y-m')] ?? []),
            (array)($db['assignments'][$start->modify('-1 month')->format('Y-m')] ?? []),
            $assignments
        );
        unset($view[$driverId . '|' . $date]);
        $prevDate = self::shiftDate($date, -1);
        $prevCode = self::assignmentAt($view, $driverId, $prevDate);
        if (!ctype_digit($prevCode)) {
            return ['ok' => true, 'reason' => ''];
        }
        $minutes = self::restMinutesBetween(
            $allByCode, (array)($db['holidays'] ?? []), $prevDate, $prevCode, $date, $code
        );
        if ($minutes >= $minRest) {
            return ['ok' => true, 'reason' => ''];
        }
        if ($minutes < $reducedMin || $reducedMin >= $minRest) {
            return ['ok' => false, 'reason' => 'Descanso insuficiente entre turnos: ' . self::hoursLabel($minutes)];
        }
        $used = self::reducedRestUsage(
            $view, $allByCode, (array)($db['holidays'] ?? []), $driverId, $date,
            $reducedMin, $minRest, $weeklyRest
        );
        if ($used + 1 > $maxReduced) {
            return [
                'ok' => false,
                'reason' => "Máximo {$maxReduced} descansos reducidos entre descansos semanales",
            ];
        }
        return ['ok' => true, 'reason' => ''];
    }

    /**
     * Aplica cambios de celdas validando conductor, línea y bus.
     *
     * @return array{assignments:array,vehicleAssignments:array,rejected:list<array<string,string>>,reassigned:list<array<string,string>>,saved:int}
     */
    public static function resolveAssignmentChanges(array $db, string $month, array $changes): array
    {
        $assignments = (array)($db['assignments'][$month] ?? []);
        $vehicleAssignments = (array)($db['vehicleAssignments'][$month] ?? []);
        $ctx = self::vehicleContext($db);
        $drivers = [];
        foreach ($db['drivers'] ?? [] as $driver) {
            if (self::isRosterDriver($driver)) {
                $drivers[(string)($driver['id'] ?? '')] = $driver;
            }
        }
        $rejected = [];
        $reassigned = [];
        $saved = 0;

        foreach ($changes as $change) {
            if (!is_array($change)) {
                continue;
            }
            $driverId = trim((string)($change['driverId'] ?? ''));
            $date = trim((string)($change['date'] ?? ''));
            $value = Store::normaliseStatusValue(trim((string)($change['value'] ?? '')));
            if ($driverId === '' || !isset($drivers[$driverId]) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) || substr($date, 0, 7) !== $month) {
                continue;
            }
            $key = $driverId . '|' . $date;
            if ($value === '') {
                unset($assignments[$key], $vehicleAssignments[$key]);
                $saved++;
                continue;
            }
            if (in_array($value, self::STATUS_CODES, true)) {
                $assignments[$key] = $value;
                unset($vehicleAssignments[$key]);
                $saved++;
                continue;
            }
            $shift = $ctx['shifts'][(int)$value] ?? null;
            $dayKind = self::dayType($date, $ctx['holidays']);
            $variant = $shift['variants'][$dayKind] ?? null;
            if (!$shift || !$variant) {
                $rejected[] = [
                    'driverId' => $driverId,
                    'date' => $date,
                    'value' => $value,
                    'reason' => 'El turno no existe para este tipo de día',
                ];
                continue;
            }
            $rest = self::manualRestCheck($db, $assignments, $driverId, $date, (string)$value);
            if (!$rest['ok']) {
                $rejected[] = [
                    'driverId' => $driverId,
                    'date' => $date,
                    'value' => $value,
                    'reason' => $rest['reason'],
                ];
                continue;
            }
            $decision = self::chooseServiceVehicle(
                $ctx,
                $drivers[$driverId],
                $shift,
                $variant,
                (int)$value,
                $dayKind,
                $date,
                $assignments,
                $vehicleAssignments,
                $key
            );
            if (!$decision['ok']) {
                $rejected[] = [
                    'driverId' => $driverId,
                    'date' => $date,
                    'value' => $value,
                    'reason' => $decision['reason'],
                ];
                continue;
            }
            $assignments[$key] = $value;
            $vehicleAssignments[$key] = $decision['vehicle'];
            if ($decision['reassigned']) {
                $reassigned[] = [
                    'driverId' => $driverId,
                    'date' => $date,
                    'from' => self::shiftVehicleFor($shift, $dayKind),
                    'to' => $decision['vehicle'],
                ];
            }
            $saved++;
        }
        return [
            'assignments' => $assignments,
            'vehicleAssignments' => $vehicleAssignments,
            'rejected' => $rejected,
            'reassigned' => $reassigned,
            'saved' => $saved,
        ];
    }

    private static function absenceFor(array $absences, string $driverId, string $date): ?array
    {
        foreach ($absences as $a) {
            if ((string)($a['driverId'] ?? '') !== $driverId) {
                continue;
            }
            if ((string)($a['from'] ?? '') <= $date && $date <= (string)($a['to'] ?? '')) {
                return $a;
            }
        }
        return null;
    }

    /* ------------------------------------------------------------------ */
    /* Autoasignación                                                     */
    /* ------------------------------------------------------------------ */

    private static function shiftDate(string $date, int $days): string
    {
        $sign = $days >= 0 ? '+' : '';
        return (new DateTimeImmutable($date))->modify($sign . $days . ' days')->format('Y-m-d');
    }

    private static function assignmentAt(array $result, string $driverId, string $date): string
    {
        return (string)($result[$driverId . '|' . $date] ?? '');
    }

    /** @return array{count:int,start:string} */
    private static function streakBefore(array $result, string $driverId, string $date): array
    {
        $count = 0;
        $cursor = self::shiftDate($date, -1);
        while ($count < 60 && self::isWorkCode(self::assignmentAt($result, $driverId, $cursor))) {
            $count++;
            $cursor = self::shiftDate($cursor, -1);
        }
        return ['count' => $count, 'start' => self::shiftDate($date, -$count)];
    }

    /**
     * Jornada real (código numérico) más cercana en una dirección. La X se
     * ignora: cuenta para rachas, pero no tiene horario para medir descansos.
     *
     * @return array{date:string,code:string}
     */
    private static function realWorkNear(array $result, string $driverId, string $date, int $step): array
    {
        $cursor = $date;
        for ($i = 0; $i < 70; $i++) {
            $code = self::assignmentAt($result, $driverId, $cursor);
            if (ctype_digit($code)) {
                return ['date' => $cursor, 'code' => $code];
            }
            $cursor = self::shiftDate($cursor, $step);
        }
        return ['date' => '', 'code' => ''];
    }

    /** @return array{minutes:int,key:string,dates:array<int,string>}|null */
    private static function restBefore(array $result, array $byCode, array $holidays, string $driverId, string $streakStart): ?array
    {
        $cursor = self::shiftDate($streakStart, -1);
        $restDays = [];
        for ($i = 0; $i < 70; $i++) {
            $code = self::assignmentAt($result, $driverId, $cursor);
            if (ctype_digit($code)) {
                break;
            }
            // La X no es descanso ni turno con horario: se omite.
            if ($code !== 'X') {
                $restDays[] = $cursor;
            }
            $cursor = self::shiftDate($cursor, -1);
        }
        if (!$restDays) {
            return null;
        }
        $key = end($restDays);
        $previous = self::realWorkNear($result, $driverId, $key, -1);
        $previousVariant = $previous['code'] !== ''
            ? self::variantForCode($byCode, $previous['code'], $previous['date'], $holidays)
            : null;
        $previousEnd = $previousVariant ? self::variantMinutes($previousVariant)[1] : 1440;
        $first = self::realWorkNear($result, $driverId, $streakStart, 1);
        $firstVariant = $first['code'] !== ''
            ? self::variantForCode($byCode, $first['code'], $first['date'], $holidays)
            : null;
        $firstStart = $firstVariant ? self::variantMinutes($firstVariant)[0] : 0;
        return [
            'minutes' => (1440 - $previousEnd) + count($restDays) * 1440 + $firstStart,
            'key' => $key,
            'dates' => $restDays,
        ];
    }

    /** @return array{minutes:int,key:string,dates:array<int,string>}|null */
    private static function restAfter(array $result, array $byCode, array $holidays, string $driverId, string $streakEnd): ?array
    {
        $cursor = self::shiftDate($streakEnd, 1);
        $restDays = [];
        for ($i = 0; $i < 70; $i++) {
            $code = self::assignmentAt($result, $driverId, $cursor);
            if (ctype_digit($code)) {
                break;
            }
            if ($code !== 'X') {
                $restDays[] = $cursor;
            }
            $cursor = self::shiftDate($cursor, 1);
        }
        if (!$restDays) {
            return null;
        }
        $end = self::realWorkNear($result, $driverId, $streakEnd, -1);
        $endVariant = $end['code'] !== ''
            ? self::variantForCode($byCode, $end['code'], $end['date'], $holidays)
            : null;
        $endMinute = $endVariant ? self::variantMinutes($endVariant)[1] : 1440;
        $nextWork = self::shiftDate(end($restDays), 1);
        $nextCode = self::assignmentAt($result, $driverId, $nextWork);
        $nextVariant = self::variantForCode($byCode, $nextCode, $nextWork, $holidays);
        $nextStart = $nextVariant ? self::variantMinutes($nextVariant)[0] : 1440;
        return [
            'minutes' => (1440 - $endMinute) + count($restDays) * 1440 + $nextStart,
            'key' => $restDays[0],
            'dates' => $restDays,
        ];
    }

    /** Horario de un código: solo los turnos reales tienen jornada. La X no tiene horario. */
    private static function variantForCode(
        array $byCode, string $code, string $date, array $holidays
    ): ?array {
        if (!ctype_digit($code)) {
            return null;
        }
        return $byCode[(int)$code]['variants'][self::dayType($date, $holidays)] ?? null;
    }

    /** Minutos de descanso entre dos jornadas de trabajo consecutivas. */
    private static function restMinutesBetween(
        array $byCode, array $holidays, string $prevDate, string $prevCode, string $nextDate, string $nextCode
    ): int {
        $prevVariant = self::variantForCode($byCode, $prevCode, $prevDate, $holidays);
        $prevEnd = $prevVariant ? self::variantMinutes($prevVariant)[1] : 1440;
        $nextVariant = self::variantForCode($byCode, $nextCode, $nextDate, $holidays);
        $nextStart = $nextVariant ? self::variantMinutes($nextVariant)[0] : 0;
        $days = max(1, (int)(new DateTimeImmutable($prevDate))->diff(new DateTimeImmutable($nextDate))->format('%a'));
        return max(0, (1440 - $prevEnd) + ($days - 1) * 1440 + $nextStart);
    }

    /**
     * Descansos diarios reducidos ya consumidos desde el último descanso semanal.
     * El descanso semanal reinicia el contador; no se mide por semana natural.
     * El descanso que se está evaluando ($date) se excluye: se cuenta aparte.
     */
    private static function reducedRestUsage(
        array $view, array $byCode, array $holidays, string $driverId, string $date,
        int $reducedMin, int $minRest, int $weeklyRest
    ): int {
        $base = $view;
        unset($base[$driverId . '|' . $date]);
        $cursor = self::shiftDate($date, -70);
        $last = self::shiftDate($date, -1);
        $works = [];
        $guard = 0;
        while ($cursor <= $last && $guard++ < 100) {
            $code = self::assignmentAt($base, $driverId, $cursor);
            if (ctype_digit($code)) {
                $works[] = ['date' => $cursor, 'code' => $code];
            }
            $cursor = self::shiftDate($cursor, 1);
        }
        $used = 0;
        for ($i = 1; $i < count($works); $i++) {
            $prev = $works[$i - 1];
            $next = $works[$i];
            $minutes = self::restMinutesBetween(
                $byCode, $holidays, $prev['date'], $prev['code'], $next['date'], $next['code']
            );
            if ($minutes >= $weeklyRest) {
                $used = 0;
            } elseif ($minutes >= $reducedMin && $minutes < $minRest) {
                $used++;
            }
        }
        return $used;
    }

    /** Comprueba los descansos de 12 h (y el cupo de reducidos) al mover un turno. */
    private static function restAllowedForShift(
        array $view, array $byCode, array $holidays, string $driverId,
        string $date, string $code, int $minRest, int $reducedMin, int $maxReduced, int $weeklyRest
    ): bool {
        $check = static function (string $prevDate, string $prevCode, string $nextDate, string $nextCode) use (
            $byCode, $holidays, $driverId, $date, $code, $minRest, $reducedMin, $maxReduced, $weeklyRest, $view
        ): bool {
            $minutes = self::restMinutesBetween($byCode, $holidays, $prevDate, $prevCode, $nextDate, $nextCode);
            if ($minutes >= $minRest) {
                return true;
            }
            if ($minutes < $reducedMin || $reducedMin >= $minRest) {
                return false;
            }
            return self::reducedRestUsage(
                $view, $byCode, $holidays, $driverId, $date, $reducedMin, $minRest, $weeklyRest
            ) < $maxReduced;
        };
        $prevDate = self::shiftDate($date, -1);
        $prev = self::realWorkNear($view, $driverId, $prevDate, -1);
        if ($prev['date'] === $prevDate && ctype_digit($prev['code'])
            && !$check($prev['date'], $prev['code'], $date, $code)) {
            return false;
        }
        $nextDate = self::shiftDate($date, 1);
        $next = self::realWorkNear($view, $driverId, $nextDate, 1);
        if ($next['date'] === $nextDate && ctype_digit($next['code'])
            && !$check($date, $code, $next['date'], $next['code'])) {
            return false;
        }
        return true;
    }

    /** Valida la racha tras mover un turno sin contar días aún sin asignar como descanso. */
    private static function streakSafeAfterMove(
        array $view, array $byCode, array $holidays, string $driverId,
        string $date, string $code, int $max, int $extraDays, int $restMin,
        ?string $firstDay = null, ?string $lastDay = null
    ): bool {
        $probe = $view;
        $probe[$driverId . '|' . $date] = $code;
        for ($i = 1; $i <= 70; $i++) {
            foreach ([self::shiftDate($date, -$i), self::shiftDate($date, $i)] as $cursor) {
                // Solo los días aún sin asignar dentro del mes se tratan como
                // jornada al medir la racha. Fuera del mes son descanso.
                if (self::assignmentAt($probe, $driverId, $cursor) === ''
                    && ($firstDay === null || $lastDay === null
                        || ($cursor >= $firstDay && $cursor <= $lastDay))) {
                    $probe[$driverId . '|' . $cursor] = 'X';
                }
            }
        }
        $before = 0;
        $cursor = self::shiftDate($date, -1);
        while (self::isWorkCode(self::assignmentAt($probe, $driverId, $cursor))) {
            $before++;
            $cursor = self::shiftDate($cursor, -1);
        }
        $after = 0;
        $cursor = self::shiftDate($date, 1);
        while (self::isWorkCode(self::assignmentAt($probe, $driverId, $cursor))) {
            $after++;
            $cursor = self::shiftDate($cursor, 1);
        }
        $length = $before + 1 + $after;
        if ($length <= $max) {
            return true;
        }
        if ($extraDays <= $max || $length > $extraDays) {
            return false;
        }
        $start = self::shiftDate($date, -$before);
        $end = self::shiftDate($date, $after);
        $claims = self::claimedRests($probe, $byCode, $holidays, $driverId, $date, $max, $extraDays, $restMin);
        $restBefore = self::restBefore($probe, $byCode, $holidays, $driverId, $start);
        $restAfter = self::restAfter($probe, $byCode, $holidays, $driverId, $end);
        return ($restBefore && $restBefore['minutes'] >= $restMin && empty($claims[$restBefore['key']]))
            || ($restAfter && $restAfter['minutes'] >= $restMin && empty($claims[$restAfter['key']]));
    }

    /**
     * Comprueba el límite de días seguidos. Los días que superen el máximo
     * general solo se permiten hasta $extraDays y con $restMin minutos de
     * descanso propio (antes o después), no reutilizables en otro bloque.
     * Devuelve qué descanso se reserva para ese bloque.
     *
     * @param array<string,array<string,bool>> $claimed
     * @return array{ok:bool,side:string,key:string,reserve:array<int,string>}
     */
    private static function consecutiveOption(
        array $view, array $byCode, array $holidays, string $driverId,
        string $date, int $code, int $max, int $extraDays, int $restMin, array $claimed
    ): array {
        $none = ['ok' => true, 'side' => '', 'key' => '', 'reserve' => []];
        $denied = ['ok' => false, 'side' => '', 'key' => '', 'reserve' => []];
        $streak = self::streakBefore($view, $driverId, $date);
        if ($streak['count'] < $max) {
            return $none;
        }
        if ($extraDays <= $max || $streak['count'] >= $extraDays) {
            return $denied;
        }
        $virtual = $view;
        $virtual[$driverId . '|' . $date] = (string)$code;
        $claims = $claimed + self::claimedRests($view, $byCode, $holidays, $driverId, $date, $max, $extraDays, $restMin);
        $before = self::restBefore($virtual, $byCode, $holidays, $driverId, $streak['start']);
        if ($before && $before['minutes'] >= $restMin && empty($claims[$before['key']])) {
            return ['ok' => true, 'side' => 'before', 'key' => $before['key'], 'reserve' => []];
        }
        $after = self::restAfter($virtual, $byCode, $holidays, $driverId, $date);
        if ($after && $after['minutes'] >= $restMin && empty($claims[$after['key']])) {
            // Jornadas completas suficientes para garantizar el descanso aunque
            // aún no estén asignadas (48 h -> 2 días, 72 h -> 3, etc.).
            $reserveDays = max(1, (int)ceil($restMin / 1440));
            return [
                'ok' => true, 'side' => 'after', 'key' => $after['key'],
                'reserve' => array_slice($after['dates'], 0, $reserveDays),
            ];
        }
        return $denied;
    }

    /**
     * Descansos ya consumidos por bloques largos del historial, incluidos los
     * que empiezan en el mes anterior. Evita reutilizar un mismo descanso para
     * dos bloques de excepción al pasar de un mes a otro.
     *
     * @return array<string,bool>
     */
    private static function claimedRests(
        array $view, array $byCode, array $holidays, string $driverId,
        string $date, int $max, int $extraDays, int $restMin
    ): array {
        $claims = [];
        if ($extraDays <= $max) {
            return $claims;
        }
        $cursor = self::shiftDate($date, -70);
        $limit = self::shiftDate($date, 70);
        $guard = 0;
        while ($cursor <= $limit && $guard++ < 200) {
            if (!self::isWorkCode(self::assignmentAt($view, $driverId, $cursor))) {
                $cursor = self::shiftDate($cursor, 1);
                continue;
            }
            $blockEnd = $cursor;
            while (self::isWorkCode(self::assignmentAt($view, $driverId, self::shiftDate($blockEnd, 1)))) {
                $blockEnd = self::shiftDate($blockEnd, 1);
            }
            $length = (int)(new DateTimeImmutable($cursor))->diff(new DateTimeImmutable($blockEnd))->format('%a') + 1;
            $includesDate = $cursor <= $date && $date <= $blockEnd;
            if ($length >= $max + 1 && !$includesDate) {
                $before = self::restBefore($view, $byCode, $holidays, $driverId, $cursor);
                $after = self::restAfter($view, $byCode, $holidays, $driverId, $blockEnd);
                if ($before && $before['minutes'] >= $restMin) {
                    $claims[$before['key']] = true;
                } elseif ($after && $after['minutes'] >= $restMin) {
                    $claims[$after['key']] = true;
                }
            }
            $cursor = self::shiftDate($blockEnd, 1);
        }
        return $claims;
    }

    /**
     * Genera un cuadrante equilibrado para el mes.
     * Respeta ausencias, descanso mínimo y máximo de días consecutivos, y solo
     * asigna servicios cuyo bus sea válido para el conductor y la línea.
     *
     * @return array{db:array,stats:array{generated:int,reassigned:int,uncovered:int}}
     */
    public function autoAssign(string $month, bool $overwrite = true, ?int $seed = null): array
    {
        $db = $this->load();
        $days = self::monthDays($month);
        $shifts = array_values(array_filter($db['shifts'], static fn($s) => !empty($s['active']) && empty($s['deepInactive'])));
        $drivers = array_values(array_filter($db['drivers'], [self::class, 'isRosterDriver']));
        $absences = $db['absences'];
        $holidays = $db['holidays'];
        $needs = $db['needs'];
        $maxConsecutive = max(1, (int)($db['settings']['maxConsecutive'] ?? 5));
        $exceptionDays = max(0, min(14, (int)($db['settings']['exceptionDays'] ?? 6)));
        $exceptionRestMin = max(1, min(168, (int)($db['settings']['exceptionRest'] ?? 48))) * 60;
        $maxWorkDays = $exceptionDays > $maxConsecutive ? $exceptionDays : $maxConsecutive;
        $minRest = max(0, (int)($db['settings']['minRest'] ?? 12)) * 60;
        $reducedMin = max(1, min(24, (int)($db['settings']['reducedRestMin'] ?? 9))) * 60;
        $maxReduced = max(0, min(14, (int)($db['settings']['maxReducedRests'] ?? 3)));
        // El descanso semanal que reinicia el cupo es el umbral continuo de
        // Ajustes (48 h por defecto), no una semana natural.
        $weeklyRest = $exceptionRestMin;
        if (!$drivers || !$shifts) {
            throw new RuntimeException('Faltan conductores o turnos para autoasignar.');
        }

        // Tope de jornadas virtuales: el mismo plan que muestra Ajustes.
        // La X no se usa como comodín para dar 21 jornadas a todos: si hay más
        // conductores que turnos, el trabajo se reparte entre todos y cada uno
        // tiene más días libres.
        $totalNeed = 0;
        foreach ($days as $date) {
            $totalNeed += (int)($needs[self::dayType($date, $holidays)] ?? 0);
        }
        $baseFreeDays = self::freeDaysFor($db, $month);
        $baseWorkDays = max(1, count($days) - $baseFreeDays);
        $neededDrivers = (int)ceil($totalNeed / $baseWorkDays);
        $planX = max(0, $neededDrivers * $baseWorkDays - $totalNeed);
        // Quien está de ausencia todo el mes no puede cubrir turnos: el trabajo
        // se reparte entre los conductores con algún día disponible.
        $availableDays = [];
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            $absent = 0;
            foreach ($days as $date) {
                if (self::absenceFor($absences, $id, $date) !== null) {
                    $absent++;
                }
            }
            $availableDays[$id] = count($days) - $absent;
        }
        $availableDrivers = count(array_filter($availableDays, static fn(int $n): bool => $n > 0));
        if ($availableDrivers === 0) {
            $availableDrivers = count($drivers);
        }
        // El derecho a días libres es el que marca Ajustes para el mes: el
        // reparto entre conductores disponibles no lo aumenta. Subirlo dejaba
        // jornadas sin cubrir y conductores con dos libres de más.
        $restTarget = $baseFreeDays;
        $restTargetFor = [];
        $restMinFor = [];
        $daysInMonth = count($days);
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            if ($availableDays[$id] < $daysInMonth) {
                // Solo quien está de baja/vacaciones recibe la parte
                // proporcional de los libres del mes: (libres / días del mes)
                // × días en los que realmente puede trabajar. Ejemplo 9/30×20=6.
                $proportional = (int)round($baseFreeDays / max(1, $daysInMonth) * $availableDays[$id]);
                $restTargetFor[$id] = min($restTarget, $availableDays[$id], $proportional);
            } else {
                $restTargetFor[$id] = min($restTarget, $availableDays[$id]);
            }
            $restMinFor[$id] = max(0, $restTargetFor[$id] - 1);
        }
        $restMin = max(0, $restTarget - 1);

        mt_srand($seed ?? crc32($month));
        $byCode = [];
        $allByCode = [];
        foreach ($db['shifts'] as $s) {
            $allByCode[(int)$s['code']] = $s;
        }
        foreach ($shifts as $s) {
            $byCode[(int)$s['code']] = $s;
        }
        $ctx = self::vehicleContext($db);

        $result = $overwrite ? [] : (array)($db['assignments'][$month] ?? []);
        $vehicleResult = $overwrite ? [] : (array)($db['vehicleAssignments'][$month] ?? []);
        // Historial de los dos meses anteriores: permite medir rachas y descansos
        // que empiezan antes del día 1 del mes que se está generando.
        $start = new DateTimeImmutable($month . '-01');
        $history = array_merge(
            (array)($db['assignments'][$start->modify('-2 months')->format('Y-m')] ?? []),
            (array)($db['assignments'][$start->modify('-1 month')->format('Y-m')] ?? [])
        );
        $driversById = [];
        foreach ($drivers as $drv) {
            $driversById[(string)$drv['id']] = $drv;
        }
        // Ausencias ya conocidas del mes: sirven para saber cuántos días libres
        // le quedan a cada conductor y no quedarse por debajo del mínimo.
        $absenceSuffix = [];
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            $pending = 0;
            for ($i = count($days) - 1; $i >= 0; $i--) {
                if (self::absenceFor($absences, $id, $days[$i]) !== null) {
                    $pending++;
                }
                $absenceSuffix[$id][$i] = $pending;
            }
        }
        $generated = 0;
        $reassigned = 0;
        $uncovered = 0;
        $paired = 0;
        $crossGroup = 0;
        $virtual = 0;
        // Descansos ya puestos en el mes (importa cuando no se sobrescribe).
        $restDays = [];
        foreach ($result as $key => $value) {
            if ($value === 'D') {
                $id = substr((string)$key, 0, strrpos((string)$key, '|'));
                $restDays[$id] = ($restDays[$id] ?? 0) + 1;
            }
        }
        $hasGroups = false;
        foreach ($drivers as $drv) {
            if (in_array(strtoupper(trim((string)($drv['group'] ?? ''))), ['A', 'B'], true)) {
                $hasGroups = true;
                break;
            }
        }
        $worked = [];
        $consec = [];
        /** Racha de D consecutivos dentro del mes que se está generando. */
        $dStreak = [];
        $lastEnd = [];
        $lastDate = [];
        /** Descansos de 48 h ya usados por un bloque de seis días. */
        $claimed = [];
        /** Jornadas reservadas como descanso de un bloque de seis días. */
        $reserved = [];
        // Arranca con la racha real de los últimos días del mes anterior y con
        // la hora de fin del último turno, también para el descanso de 12 h.
        $prev = $start->modify('-1 day');
        $seeded = [];
        for ($i = 1; $i <= $maxWorkDays; $i++) {
            $d = $prev->format('Y-m-d');
            foreach ($drivers as $drv) {
                $id = (string)$drv['id'];
                if (!empty($seeded[$id])) {
                    continue;
                }
                $v = $history[$id . '|' . $d] ?? null;
                if ($v === null || !self::isWorkCode((string)$v)) {
                    $seeded[$id] = true;
                    continue;
                }
                $consec[$id] = ($consec[$id] ?? 0) + 1;
                if (!isset($lastDate[$id])) {
                    $lastDate[$id] = $d;
                    $variant = self::variantForCode($allByCode, (string)$v, $d, $holidays);
                    if ($variant) {
                        $lastEnd[$id] = (int)$variant['endMin'];
                    }
                }
            }
            $prev = $prev->modify('-1 day');
        }

        /**
         * Valida el descanso entre la última jornada y el turno candidato.
         * Por debajo del mínimo normal solo se admite el descanso reducido
         * mientras no se agote el cupo desde el último descanso semanal.
         */
        $restOk = function (string $id, string $date, int $code, array $variant) use (
            $history, &$result, $allByCode, $holidays, $minRest, $reducedMin, $maxReduced, $weeklyRest
        ): bool {
            $previous = (new DateTimeImmutable($date))->modify('-1 day')->format('Y-m-d');
            $view = array_merge($history, $result);
            $previousCode = self::assignmentAt($view, $id, $previous);
            if (!ctype_digit($previousCode)) {
                return true;
            }
            $previousVariant = self::variantForCode($allByCode, $previousCode, $previous, $holidays);
            if (!$previousVariant) {
                return true;
            }
            [$start, $previousEnd] = [self::variantMinutes($variant)[0], self::variantMinutes($previousVariant)[1]];
            if ($start < $previousEnd) {
                $start += 1440;
            }
            $rest = $start - $previousEnd;
            if ($rest >= $minRest) {
                return true;
            }
            if ($rest < $reducedMin || $reducedMin >= $minRest) {
                return false;
            }
            $used = self::reducedRestUsage(
                array_merge($history, $result), $allByCode, $holidays, $id, $date,
                $reducedMin, $minRest, $weeklyRest
            );
            return $used + 1 <= $maxReduced;
        };

        foreach ($days as $dayIdx => $date) {
            $remainingDays = count($days) - $dayIdx;
            $kind = self::dayType($date, $holidays);
            $codes = self::validCodes($shifts, $kind);
            $need = max(0, (int)($needs[$kind] ?? 0));
            if ($kind === 'lv') {
                $pref = array_values(array_filter($codes, static fn($c) => ($byCode[$c]['line'] ?? 'REF') !== 'REF'));
                $rest = array_values(array_filter($codes, static fn($c) => ($byCode[$c]['line'] ?? 'REF') === 'REF'));
                $codes = array_slice(array_merge($pref, $rest), 0, $need);
            } else {
                $codes = array_slice($codes, 0, $need);
            }
            // Se agrupan las parejas (1,2), (3,4)… pero se sortea el orden de
            // las parejas: el turno impar se cubre antes para que el par pueda
            // heredar su bus cuando no solapen.
            $pairs = [];
            foreach ($codes as $c) {
                $pairs[(int)ceil($c / 2)][] = $c;
            }
            $pairKeys = array_keys($pairs);
            shuffle($pairKeys);
            $orderedCodes = [];
            foreach ($pairKeys as $pairKey) {
                $group = $pairs[$pairKey];
                sort($group);
                $orderedCodes = array_merge($orderedCodes, $group);
            }
            $codes = $orderedCodes;

            $linesOfDay = [];
            foreach ($codes as $c) {
                $linesOfDay[self::shiftLineFor($byCode[$c], $kind)] = true;
            }
            $candidates = [];
            foreach ($drivers as $drv) {
                $id = (string)$drv['id'];
                // Si no puede conducir ningún bus de las líneas del día, se
                // descarta antes de probar turno por turno.
                $hasVehicle = false;
                foreach ($ctx['vehicles'] as $vehicle) {
                    if (($vehicle['status'] ?? 'disponible') === 'taller') {
                        continue;
                    }
                    foreach (array_keys($linesOfDay) as $lineCode) {
                        if (self::vehicleIsSuitable($ctx, $drv, $vehicle, $lineCode)) {
                            $hasVehicle = true;
                            break 2;
                        }
                    }
                }
                if (!$hasVehicle) {
                    continue;
                }
                if (self::absenceFor($absences, $id, $date) !== null) {
                    continue;
                }
                if (!empty($reserved[$id][$date])) {
                    continue;
                }
                // Si con los días que le quedan solo puede alcanzar el mínimo
                // de descansos, hoy no puede trabajar: necesita ese D.
                $availableRest = $remainingDays - ($absenceSuffix[$id][$dayIdx] ?? 0);
                if (($restDays[$id] ?? 0) + $availableRest <= ($restMinFor[$id] ?? $restMin)) {
                    continue;
                }
                if (($consec[$id] ?? 0) >= $maxWorkDays) {
                    continue;
                }
                $compatible = false;
                foreach ($codes as $c) {
                    if ($restOk($id, $date, $c, $byCode[$c]['variants'][$kind])) {
                        $compatible = true;
                        break;
                    }
                }
                if (!$compatible) {
                    continue;
                }
                $group = strtoupper(trim((string)($drv['group'] ?? '')));
                $candidates[] = [
                    'id' => $id,
                    'group' => in_array($group, ['A', 'B'], true) ? $group : '',
                    'partner' => trim((string)($drv['partnerId'] ?? '')),
                    'worked' => $worked[$id] ?? 0,
                    'consec' => $consec[$id] ?? 0,
                    // Quien ya lleva tres D seguidos debe trabajar hoy: darle
                    // otro D sería el origen de las rachas de cuatro o más.
                    'breakRun' => ($dStreak[$id] ?? 0) >= 3,
                    'rnd' => mt_rand() / mt_getrandmax(),
                ];
            }
            usort($candidates, static function ($a, $b) {
                return [($a['breakRun'] ? 0 : 1), $a['worked'], $a['consec'], $a['rnd']]
                    <=> [($b['breakRun'] ? 0 : 1), $b['worked'], $b['consec'], $b['rnd']];
            });
            $candidateById = [];
            foreach ($candidates as $idx => $candidate) {
                $candidateById[$candidate['id']] = $idx;
            }
            $forceBreak = false;
            foreach ($candidates as $candidate) {
                if ($candidate['breakRun']) {
                    $forceBreak = true;
                    break;
                }
            }
            $offset = $forceBreak
                ? 0
                : (int)(new DateTimeImmutable($date))->format('z') * 7 % max(1, count($codes));
            $usedCandidates = [];
            $dayAssigned = 0;
            $filled = [];
            $assignedDriverByCode = [];
            $slots = self::usedVehicleSlots($ctx, $date, $result, $vehicleResult);

            // Grupo A para impares (mañana) y B para pares (tarde). Los sin grupo
            // entran después; cambiar de grupo solo se usa si no queda otra.
            $preferredGroup = static fn(int $code): string => ($code % 2 === 1) ? 'A' : 'B';
            $groupRank = static function (array $candidate, int $code) use ($preferredGroup, $hasGroups): int {
                if (!$hasGroups) {
                    return 0;
                }
                if ($candidate['group'] === $preferredGroup($code)) {
                    return 0;
                }
                return $candidate['group'] === '' ? 1 : 2;
            };
            $allowed = static fn(int $rank, bool $strict): bool => !$strict || $rank <= 1;

            $commit = function (int $idx, int $code, array $decision, array $consecutive) use (
                &$candidates, &$result, &$vehicleResult, &$slots, &$usedCandidates,
                &$generated, &$reassigned, &$crossGroup, &$dayAssigned, &$worked, &$consec, &$dStreak,
                &$lastEnd, &$lastDate, &$claimed, &$reserved,
                $date, $kind, $byCode, $groupRank
            ): void {
                $candidate = $candidates[$idx];
                $id = $candidate['id'];
                $key = $id . '|' . $date;
                $result[$key] = (string)$code;
                $vehicleResult[$key] = $decision['vehicle'];
                [$slotStart, $slotEnd] = self::variantMinutes($byCode[$code]['variants'][$kind]);
                $slots[$decision['vehicle']][] = [$slotStart, $slotEnd];
                $usedCandidates[$idx] = true;
                $generated++;
                $dayAssigned++;
                if ($decision['reassigned']) {
                    $reassigned++;
                }
                if ($groupRank($candidate, $code) === 2) {
                    $crossGroup++;
                }
                $worked[$id] = ($worked[$id] ?? 0) + 1;
                $consec[$id] = ($consec[$id] ?? 0) + 1;
                $dStreak[$id] = 0;
                $lastEnd[$id] = (int)$byCode[$code]['variants'][$kind]['endMin'];
                $lastDate[$id] = $date;
                if ($consecutive['side'] !== '') {
                    $claimed[$id][$consecutive['key']] = true;
                    foreach ($consecutive['reserve'] as $restDate) {
                        $reserved[$id][$restDate] = true;
                    }
                }
            };

            $assign = function (int $idx, int $code, bool $strict) use (
                &$candidates, &$result, &$vehicleResult, &$slots, &$usedCandidates, &$commit,
                $groupRank, $allowed, $byCode, $kind, $date, $ctx, $driversById,
                $holidays, $maxConsecutive, $exceptionDays, $exceptionRestMin,
                $history, $allByCode, $claimed, $restOk
            ): bool {
                if (isset($usedCandidates[$idx]) || !$allowed($groupRank($candidates[$idx], $code), $strict)) {
                    return false;
                }
                $shift = $byCode[$code] ?? null;
                $variant = $shift['variants'][$kind] ?? null;
                if (!$shift || !$variant) {
                    return false;
                }
                $id = $candidates[$idx]['id'];
                $key = $id . '|' . $date;
                if (!$restOk($id, $date, $code, $variant)) {
                    return false;
                }
                $consecutive = self::consecutiveOption(
                    array_merge($history, $result), $allByCode, $holidays, $id, $date, $code,
                    $maxConsecutive, $exceptionDays, $exceptionRestMin, $claimed[$id] ?? []
                );
                if (!$consecutive['ok']) {
                    return false;
                }
                $decision = self::chooseServiceVehicle(
                    $ctx, $driversById[$id], $shift, $variant, $code, $kind, $date,
                    $result, $vehicleResult, $key, $slots
                );
                if (!$decision['ok']) {
                    return false;
                }
                $commit($idx, $code, $decision, $consecutive);
                return true;
            };

            $assignPair = function (int $oddIdx, int $evenIdx, int $oddCode, int $evenCode, bool $strict) use (
                &$candidates, &$result, &$vehicleResult, &$slots, &$usedCandidates, &$commit, &$paired,
                $groupRank, $allowed, $byCode, $kind, $date, $ctx, $driversById,
                $holidays, $maxConsecutive, $exceptionDays, $exceptionRestMin,
                $history, $allByCode, $claimed, $restOk
            ): bool {
                if ($oddIdx === $evenIdx || isset($usedCandidates[$oddIdx]) || isset($usedCandidates[$evenIdx])) {
                    return false;
                }
                if (!$allowed($groupRank($candidates[$oddIdx], $oddCode), $strict)
                    || !$allowed($groupRank($candidates[$evenIdx], $evenCode), $strict)) {
                    return false;
                }
                $oddShift = $byCode[$oddCode] ?? null;
                $evenShift = $byCode[$evenCode] ?? null;
                $oddVariant = $oddShift['variants'][$kind] ?? null;
                $evenVariant = $evenShift['variants'][$kind] ?? null;
                if (!$oddShift || !$evenShift || !$oddVariant || !$evenVariant) {
                    return false;
                }
                $oddId = $candidates[$oddIdx]['id'];
                $evenId = $candidates[$evenIdx]['id'];
                $oddKey = $oddId . '|' . $date;
                $evenKey = $evenId . '|' . $date;
                if (!$restOk($oddId, $date, $oddCode, $oddVariant)
                    || !$restOk($evenId, $date, $evenCode, $evenVariant)) {
                    return false;
                }
                $oddConsecutive = self::consecutiveOption(
                    array_merge($history, $result), $allByCode, $holidays, $oddId, $date, $oddCode,
                    $maxConsecutive, $exceptionDays, $exceptionRestMin, $claimed[$oddId] ?? []
                );
                $evenConsecutive = self::consecutiveOption(
                    array_merge($history, $result), $allByCode, $holidays, $evenId, $date, $evenCode,
                    $maxConsecutive, $exceptionDays, $exceptionRestMin, $claimed[$evenId] ?? []
                );
                if (!$oddConsecutive['ok'] || !$evenConsecutive['ok']) {
                    return false;
                }
                $oddDecision = self::chooseServiceVehicle(
                    $ctx, $driversById[$oddId], $oddShift, $oddVariant, $oddCode, $kind, $date,
                    $result, $vehicleResult, $oddKey, $slots
                );
                if (!$oddDecision['ok']) {
                    return false;
                }
                // Se comprueba el par con el impar ya simulado para que el bus de
                // relevo se tenga en cuenta, pero no se guarda nada hasta que ambos
                // servicios sean válidos.
                $tmpResult = $result;
                $tmpVehicles = $vehicleResult;
                $tmpSlots = $slots;
                $tmpResult[$oddKey] = (string)$oddCode;
                $tmpVehicles[$oddKey] = $oddDecision['vehicle'];
                [$slotStart, $slotEnd] = self::variantMinutes($oddVariant);
                $tmpSlots[$oddDecision['vehicle']][] = [$slotStart, $slotEnd];
                $evenDecision = self::chooseServiceVehicle(
                    $ctx, $driversById[$evenId], $evenShift, $evenVariant, $evenCode, $kind, $date,
                    $tmpResult, $tmpVehicles, $evenKey, $tmpSlots
                );
                if (!$evenDecision['ok']) {
                    return false;
                }
                $commit($oddIdx, $oddCode, $oddDecision, $oddConsecutive);
                $commit($evenIdx, $evenCode, $evenDecision, $evenConsecutive);
                $paired++;
                return true;
            };

            $assignIndividual = function (int $code, bool $strict) use (
                &$candidates, &$candidateById, &$usedCandidates, &$assignedDriverByCode, &$assign,
                $codes, $offset
            ): bool {
                $position = array_search($code, $codes, true);
                $startIdx = ($offset + ($position === false ? 0 : $position)) % max(1, count($candidates));
                // Si el turno impar ya tiene compañero, se intenta colocar aquí al
                // compañero fijo antes que a cualquier otro conductor.
                if ($code % 2 === 0) {
                    $previousDriver = $assignedDriverByCode[$code - 1] ?? '';
                    if ($previousDriver !== '' && isset($candidateById[$previousDriver])) {
                        $partnerId = $candidates[$candidateById[$previousDriver]]['partner'];
                        if ($partnerId !== '' && isset($candidateById[$partnerId])) {
                            $hint = $candidateById[$partnerId];
                            if ($assign($hint, $code, $strict)) {
                                $assignedDriverByCode[$code] = $candidates[$hint]['id'];
                                return true;
                            }
                        }
                    }
                }
                $tries = 0;
                while ($tries < count($candidates)) {
                    $idx = ($startIdx + $tries) % count($candidates);
                    $tries++;
                    if (isset($usedCandidates[$idx])) {
                        continue;
                    }
                    if ($assign($idx, $code, $strict)) {
                        $assignedDriverByCode[$code] = $candidates[$idx]['id'];
                        return true;
                    }
                }
                return false;
            };

            $pairGroups = [];
            foreach ($codes as $code) {
                $pairGroups[(int)ceil($code / 2)][] = $code;
            }

            // Pasada estricta: parejas fijas y grupo preferido (A mañana, B tarde).
            foreach ($pairGroups as $groupCodes) {
                sort($groupCodes);
                $odd = null;
                $even = null;
                foreach ($groupCodes as $code) {
                    if ($code % 2 === 1) {
                        $odd = $code;
                    } else {
                        $even = $code;
                    }
                }
                if ($odd !== null && $even !== null && !isset($filled[$odd]) && !isset($filled[$even])) {
                    foreach ($candidates as $idx => $candidate) {
                        $partnerId = $candidate['partner'];
                        if ($partnerId === '' || !isset($candidateById[$partnerId])) {
                            continue;
                        }
                        $partnerIdx = $candidateById[$partnerId];
                        if ($assignPair($idx, $partnerIdx, $odd, $even, true)) {
                            $filled[$odd] = true;
                            $filled[$even] = true;
                            $assignedDriverByCode[$odd] = $candidate['id'];
                            $assignedDriverByCode[$even] = $candidates[$partnerIdx]['id'];
                            break;
                        }
                    }
                    if (isset($filled[$odd]) && isset($filled[$even])) {
                        continue;
                    }
                }
                foreach ($groupCodes as $code) {
                    if (isset($filled[$code])) {
                        continue;
                    }
                    if ($assignIndividual($code, true)) {
                        $filled[$code] = true;
                    }
                }
            }

            // Último recurso: si aún quedan servicios, se permite saltar a un
            // conductor del otro grupo en lugar de dejarlos descubiertos.
            foreach ($codes as $code) {
                if (isset($filled[$code])) {
                    continue;
                }
                if ($assignIndividual($code, false)) {
                    $filled[$code] = true;
                }
            }

            $uncovered += count($codes) - count($filled);

            foreach ($drivers as $drv) {
                $id = (string)$drv['id'];
                $key = $id . '|' . $date;
                if (isset($result[$key])) {
                    continue;
                }
                $absence = self::absenceFor($absences, $id, $date);
                if ($absence) {
                    $result[$key] = (string)($absence['type'] ?? 'VA');
                    $consec[$id] = 0;
                    $dStreak[$id] = 0;
                    continue;
                }
                $usedRest = $restDays[$id] ?? 0;
                $availableRest = $remainingDays - ($absenceSuffix[$id][$dayIdx] ?? 0);
                // Un descanso reservado por un bloque de excepción no se puede
                // convertir en X: X cuenta como jornada y no garantiza las 48 h.
                // Tampoco se puede convertir si el conductor necesita todos los
                // días que le quedan para no bajar del mínimo de libres.
                $target = $restTargetFor[$id] ?? $restTarget;
                $floor = $restMinFor[$id] ?? $restMin;
                $mustRest = !empty($reserved[$id][$date])
                    || ($consec[$id] ?? 0) >= $maxConsecutive
                    || ($usedRest + $availableRest <= $floor);
                // Tres D seguidos ya son el máximo: el cuarto día se fuerza
                // como jornada (X si no hay servicio) aunque se haya agotado
                // el cupo del plan. La pasada final de X compensará el exceso.
                $breakRun = ($dStreak[$id] ?? 0) >= 3 && empty($reserved[$id][$date]);
                if ($breakRun && ($consec[$id] ?? 0) < $maxWorkDays) {
                    $result[$key] = 'X';
                    $consec[$id] = ($consec[$id] ?? 0) + 1;
                    $dStreak[$id] = 0;
                    $virtual++;
                    continue;
                }
                if ($mustRest || $usedRest < $target || $virtual >= $planX) {
                    $result[$key] = 'D';
                    $restDays[$id] = $usedRest + 1;
                    $consec[$id] = 0;
                    $dStreak[$id] = ($dStreak[$id] ?? 0) + 1;
                    continue;
                }
                $result[$key] = 'X';
                $consec[$id] = ($consec[$id] ?? 0) + 1;
                $dStreak[$id] = 0;
                $virtual++;
            }
        }
        /* Reequilibrio final: si alguien se pasó de los días libres objetivo,
           se convierten en X solo donde no aparezca una racha prohibida. Se
           recalcula en cada paso porque cada X alarga la racha vecina. */
        $view = array_merge($history, $result);
        /** Longitud de la racha de D que quedaría si la fecha pasara a ser D. */
        $dRunIfD = static function (string $id, string $date) use (&$view): int {
            $run = 1;
            $cursor = self::shiftDate($date, -1);
            for ($i = 0; $i < 70 && self::assignmentAt($view, $id, $cursor) === 'D'; $i++, $cursor = self::shiftDate($cursor, -1)) {
                $run++;
            }
            $cursor = self::shiftDate($date, 1);
            for ($i = 0; $i < 70 && self::assignmentAt($view, $id, $cursor) === 'D'; $i++, $cursor = self::shiftDate($cursor, 1)) {
                $run++;
            }
            return $run;
        };
        $protectedRest = [];
        // Reparación de los bloques de excepción: una X junto al descanso se
        // convierte en D para completar las 48 h. Después se compensa con otra
        // D que no sostenga ningún descanso largo.
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            $cursor = $days[0];
            $lastDay = $days[count($days) - 1];
            while ($cursor <= $lastDay) {
                if (!self::isWorkCode(self::assignmentAt($view, $id, $cursor))) {
                    $cursor = self::shiftDate($cursor, 1);
                    continue;
                }
                $end = $cursor;
                while ($end < $lastDay && self::isWorkCode(self::assignmentAt($view, $id, self::shiftDate($end, 1)))) {
                    $end = self::shiftDate($end, 1);
                }
                $length = (int)(new DateTimeImmutable($cursor))->diff(new DateTimeImmutable($end))->format('%a') + 1;
                if ($length >= $maxConsecutive + 1) {
                    $claims = self::claimedRests(
                        $view, $byCode, $holidays, $id, $cursor, $maxConsecutive, $exceptionDays, $exceptionRestMin
                    );
                    $before = self::restBefore($view, $byCode, $holidays, $id, $cursor);
                    $after = self::restAfter($view, $byCode, $holidays, $id, $end);
                    $okBefore = $before && $before['minutes'] >= $exceptionRestMin && empty($claims[$before['key']]);
                    $okAfter = $after && $after['minutes'] >= $exceptionRestMin && empty($claims[$after['key']]);
                    $restOk = $okBefore || $okAfter;
                    if ($restOk) {
                        $chosen = $okBefore ? $before : $after;
                        $reserveDays = max(1, (int)ceil($exceptionRestMin / 1440));
                        foreach (array_slice($chosen['dates'], 0, $reserveDays) as $restDate) {
                            $protectedRest[$id][$restDate] = true;
                        }
                    }
                    if (!$restOk) {
                        $candidates = [];
                        foreach ([1, 2, 3] as $offset) {
                            $candidates[] = self::shiftDate($cursor, -$offset);
                            $candidates[] = self::shiftDate($end, $offset);
                        }
                        foreach ($candidates as $candidate) {
                            if (self::assignmentAt($view, $id, $candidate) !== 'X'
                                || $dRunIfD($id, $candidate) > 3) {
                                continue;
                            }
                            $result[$id . '|' . $candidate] = 'D';
                            $view[$id . '|' . $candidate] = 'D';
                            $before = self::restBefore($view, $byCode, $holidays, $id, $cursor);
                            $after = self::restAfter($view, $byCode, $holidays, $id, $end);
                            if (($before && $before['minutes'] >= $exceptionRestMin)
                                || ($after && $after['minutes'] >= $exceptionRestMin)) {
                                $chosen = ($before && $before['minutes'] >= $exceptionRestMin) ? $before : $after;
                                $reserveDays = max(1, (int)ceil($exceptionRestMin / 1440));
                                foreach (array_slice($chosen['dates'], 0, $reserveDays) as $restDate) {
                                    $protectedRest[$id][$restDate] = true;
                                }
                                $virtual = max(0, $virtual - 1);
                                break;
                            }
                            $result[$id . '|' . $candidate] = 'X';
                            $view[$id . '|' . $candidate] = 'X';
                        }
                    }
                }
                $cursor = self::shiftDate($end, 1);
            }
        }
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            $dDates = [];
            foreach ($days as $date) {
                if (self::assignmentAt($result, $id, $date) === 'D') {
                    $dDates[] = $date;
                }
            }
            $excess = count($dDates) - ($restTargetFor[$id] ?? $restTarget);
            while ($excess > 0 && $virtual < $planX) {
                $options = [];
                foreach ($dDates as $date) {
                    if (self::assignmentAt($result, $id, $date) !== 'D' || !empty($protectedRest[$id][$date])) {
                        continue;
                    }
                    $before = 0;
                    $cursor = self::shiftDate($date, -1);
                    while ($before < 70 && self::isWorkCode(self::assignmentAt($view, $id, $cursor))) {
                        $before++;
                        $cursor = self::shiftDate($cursor, -1);
                    }
                    $after = 0;
                    $cursor = self::shiftDate($date, 1);
                    while ($after < 70 && self::isWorkCode(self::assignmentAt($view, $id, $cursor))) {
                        $after++;
                        $cursor = self::shiftDate($cursor, 1);
                    }
                    if ($before >= $maxConsecutive || $after >= $maxConsecutive) {
                        continue;
                    }
                    if ($before + 1 + $after > $maxConsecutive) {
                        continue;
                    }
                    $options[] = ['date' => $date, 'score' => $before + $after];
                }
                if (!$options) {
                    break;
                }
                usort($options, static fn($a, $b) => [$a['score'], $a['date']] <=> [$b['score'], $b['date']]);
                $chosen = $options[0]['date'];
                $result[$id . '|' . $chosen] = 'X';
                $view[$id . '|' . $chosen] = 'X';
                $virtual++;
                $excess--;
            }
        }

        /* Nivelación sin X: si alguien se pasa de libres, se le cede un turno
           de otro conductor que tiene demasiado trabajo, siempre que cumpla
           descansos, rachas, ausencias, línea y autorización de bus. */
        $restCounts = [];
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            $count = 0;
            foreach ($days as $date) {
                if (self::assignmentAt($result, $id, $date) === 'D') {
                    $count++;
                }
            }
            $restCounts[$id] = $count;
        }
        $maxRounds = count($drivers) * 2;
        for ($round = 0; $round < $maxRounds; $round++) {
            $donors = [];
            $receivers = [];
            foreach ($drivers as $drv) {
                $id = (string)$drv['id'];
                if (($availableDays[$id] ?? 0) === 0) {
                    continue;
                }
                $target = $restTargetFor[$id] ?? $restTarget;
                $delta = $restCounts[$id] - $target;
                if ($delta >= 1) {
                    $donors[] = ['id' => $id, 'delta' => $delta];
                } elseif ($delta < 0) {
                    $receivers[] = ['id' => $id, 'delta' => -$delta];
                }
            }
            if (!$donors || !$receivers) {
                break;
            }
            usort($donors, static fn(array $a, array $b): int => $b['delta'] <=> $a['delta']);
            usort($receivers, static fn(array $a, array $b): int => $b['delta'] <=> $a['delta']);
            $moved = false;
            foreach (array_slice($donors, 0, 20) as $donor) {
                $idA = (string)$donor['id'];
                foreach ($days as $date) {
                    if (self::assignmentAt($result, $idA, $date) !== 'D'
                        || self::absenceFor($absences, $idA, $date) !== null
                        || !empty($protectedRest[$idA][$date])
                        || !empty($reserved[$idA][$date])) {
                        continue;
                    }
                    foreach (array_slice($receivers, 0, 20) as $receiver) {
                        $idB = (string)$receiver['id'];
                        $code = self::assignmentAt($result, $idB, $date);
                        if (!ctype_digit($code) || $dRunIfD($idB, $date) > 3) {
                            continue;
                        }
                        $kind = self::dayType($date, $holidays);
                        $shift = $allByCode[(int)$code] ?? null;
                        $variant = $shift['variants'][$kind] ?? null;
                        if (!$shift || !$variant) {
                            continue;
                        }
                        if (!self::restAllowedForShift(
                            $view, $byCode, $holidays, $idA, $date, $code,
                            $minRest, $reducedMin, $maxReduced, $weeklyRest
                        )) {
                            continue;
                        }
                        if (!self::streakSafeAfterMove(
                            $view, $allByCode, $holidays, $idA, $date, $code,
                            $maxConsecutive, $exceptionDays, $exceptionRestMin,
                            $days[0], $days[count($days) - 1]
                        )) {
                            continue;
                        }
                        $keyA = $idA . '|' . $date;
                        $keyB = $idB . '|' . $date;
                        $decision = self::chooseServiceVehicle(
                            $ctx, $driversById[$idA], $shift, $variant, (int)$code, $kind, $date,
                            $result, $vehicleResult, $keyA, []
                        );
                        if (!$decision['ok']) {
                            continue;
                        }
                        unset($vehicleResult[$keyB]);
                        $vehicleResult[$keyA] = $decision['vehicle'];
                        $result[$keyA] = (string)$code;
                        $result[$keyB] = 'D';
                        $view[$keyA] = (string)$code;
                        $view[$keyB] = 'D';
                        $restCounts[$idA]--;
                        $restCounts[$idB]++;
                        $moved = true;
                        break 3;
                    }
                }
            }
            if (!$moved) {
                break;
            }
        }
        /* Bloques de 6 días: si otro conductor tiene una X ese mismo día y
           puede hacer el turno con las reglas del cuadrante, se le cede el
           servicio y quien llegaba a 6 días descansa. Así se reducen las X y
           se evita forzar rachas largas cuando hay capacidad disponible. */
        $xByDate = [];
        foreach ($result as $key => $value) {
            if ($value !== 'X') {
                continue;
            }
            $parts = explode('|', (string)$key);
            if (count($parts) === 2) {
                $xByDate[$parts[1]][] = $parts[0];
            }
        }
        foreach ($drivers as $drvA) {
            $idA = (string)$drvA['id'];
            $cursor = $days[0];
            $lastDay = $days[count($days) - 1];
            while ($cursor <= $lastDay) {
                if (!self::isWorkCode(self::assignmentAt($view, $idA, $cursor))) {
                    $cursor = self::shiftDate($cursor, 1);
                    continue;
                }
                $end = $cursor;
                while ($end < $lastDay && self::isWorkCode(self::assignmentAt($view, $idA, self::shiftDate($end, 1)))) {
                    $end = self::shiftDate($end, 1);
                }
                $length = (int)(new DateTimeImmutable($cursor))->diff(new DateTimeImmutable($end))->format('%a') + 1;
                if ($length >= $maxConsecutive + 1) {
                    $moved = false;
                    for ($date = $cursor; $date <= $end && !$moved; $date = self::shiftDate($date, 1)) {
                        $code = self::assignmentAt($result, $idA, $date);
                        if (!ctype_digit($code)) {
                            continue;
                        }
                        $kind = self::dayType($date, $holidays);
                        $shift = $allByCode[(int)$code] ?? null;
                        $variant = $shift['variants'][$kind] ?? null;
                        if (!$shift || !$variant) {
                            continue;
                        }
                        foreach ($xByDate[$date] ?? [] as $idB) {
                            if ($idB === $idA || self::assignmentAt($result, $idB, $date) !== 'X') {
                                continue;
                            }
                            if (self::absenceFor($absences, $idB, $date) !== null) {
                                continue;
                            }
                            if (!self::restAllowedForShift(
                                $view, $byCode, $holidays, $idB, $date, $code,
                                $minRest, $reducedMin, $maxReduced, $weeklyRest
                            )) {
                                continue;
                            }
                            if (!self::streakSafeAfterMove(
                                $view, $allByCode, $holidays, $idB, $date, $code,
                                $maxConsecutive, $exceptionDays, $exceptionRestMin,
                                $days[0], $days[count($days) - 1]
                            )) {
                                continue;
                            }
                            $keyB = $idB . '|' . $date;
                            $decision = self::chooseServiceVehicle(
                                $ctx, $driversById[$idB], $shift, $variant, (int)$code, $kind, $date,
                                $result, $vehicleResult, $keyB, []
                            );
                            if (!$decision['ok']) {
                                continue;
                            }
                            if ($dRunIfD($idA, $date) > 3) {
                                continue;
                            }
                            $keyA = $idA . '|' . $date;
                            unset($vehicleResult[$keyA]);
                            $vehicleResult[$keyB] = $decision['vehicle'];
                            $result[$keyA] = 'D';
                            $result[$keyB] = (string)$code;
                            $view[$keyA] = 'D';
                            $view[$keyB] = (string)$code;
                            $virtual--;
                            $generated++;
                            $moved = true;
                            break;
                        }
                    }
                }
                $cursor = self::shiftDate($end, 1);
            }
        }
        /* Último recurso para los bloques de 6 días sin descanso: se cede uno
           de sus turnos a un conductor que tenga un D ese día y pueda hacerlo. */
        foreach ($drivers as $drvA) {
            $idA = (string)$drvA['id'];
            $cursor = $days[0];
            $lastDay = $days[count($days) - 1];
            while ($cursor <= $lastDay) {
                if (!self::isWorkCode(self::assignmentAt($view, $idA, $cursor))) {
                    $cursor = self::shiftDate($cursor, 1);
                    continue;
                }
                $end = $cursor;
                while ($end < $lastDay && self::isWorkCode(self::assignmentAt($view, $idA, self::shiftDate($end, 1)))) {
                    $end = self::shiftDate($end, 1);
                }
                $length = (int)(new DateTimeImmutable($cursor))->diff(new DateTimeImmutable($end))->format('%a') + 1;
                if ($length >= $maxConsecutive + 1) {
                    $claims = self::claimedRests(
                        $view, $allByCode, $holidays, $idA, $cursor, $maxConsecutive, $exceptionDays, $exceptionRestMin
                    );
                    $before = self::restBefore($view, $allByCode, $holidays, $idA, $cursor);
                    $after = self::restAfter($view, $allByCode, $holidays, $idA, $end);
                    $okBefore = $before && $before['minutes'] >= $exceptionRestMin && empty($claims[$before['key']]);
                    $okAfter = $after && $after['minutes'] >= $exceptionRestMin && empty($claims[$after['key']]);
                    if (!$okBefore && !$okAfter) {
                        $moved = false;
                        for ($date = $cursor; $date <= $end && !$moved; $date = self::shiftDate($date, 1)) {
                            $code = self::assignmentAt($result, $idA, $date);
                            if (!ctype_digit($code)) {
                                continue;
                            }
                            $kind = self::dayType($date, $holidays);
                            $shift = $allByCode[(int)$code] ?? null;
                            $variant = $shift['variants'][$kind] ?? null;
                            if (!$shift || !$variant) {
                                continue;
                            }
                            foreach ($drivers as $drvB) {
                                $idB = (string)$drvB['id'];
                                if ($idB === $idA || self::assignmentAt($result, $idB, $date) !== 'D') {
                                    continue;
                                }
                                if (($restCounts[$idB] ?? 0) <= ($restMinFor[$idB] ?? $restMin)) {
                                    continue;
                                }
                                if (self::absenceFor($absences, $idB, $date) !== null) {
                                    continue;
                                }
                                if (!self::restAllowedForShift(
                                    $view, $byCode, $holidays, $idB, $date, $code,
                                    $minRest, $reducedMin, $maxReduced, $weeklyRest
                                ) || !self::streakSafeAfterMove(
                                    $view, $allByCode, $holidays, $idB, $date, $code,
                                    $maxConsecutive, $exceptionDays, $exceptionRestMin,
                                    $days[0], $days[count($days) - 1]
                                )) {
                                    continue;
                                }
                                if ($dRunIfD($idA, $date) > 3) {
                                    continue;
                                }
                                $keyA = $idA . '|' . $date;
                                $keyB = $idB . '|' . $date;
                                $decision = self::chooseServiceVehicle(
                                    $ctx, $driversById[$idB], $shift, $variant, (int)$code, $kind, $date,
                                    $result, $vehicleResult, $keyB, []
                                );
                                if (!$decision['ok']) {
                                    continue;
                                }
                                unset($vehicleResult[$keyA]);
                                $vehicleResult[$keyB] = $decision['vehicle'];
                                $result[$keyA] = 'D';
                                $result[$keyB] = (string)$code;
                                $view[$keyA] = 'D';
                                $view[$keyB] = (string)$code;
                                $restCounts[$idA]++;
                                $restCounts[$idB]--;
                                $moved = true;
                                break;
                            }
                        }
                    }
                }
                $cursor = self::shiftDate($end, 1);
            }
        }
        /* Huecos finales: si algún servicio sigue descubierto, se prueba con
           conductores que tengan un D (o, como último recurso, una X) y que
           cumplan descansos, rachas, autorizaciones y disponibilidad de bus. */
        $restCounts = [];
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            $count = 0;
            foreach ($days as $date) {
                if (self::assignmentAt($result, $id, $date) === 'D') {
                    $count++;
                }
            }
            $restCounts[$id] = $count;
        }
        foreach ($days as $date) {
            $kind = self::dayType($date, $holidays);
            $codes = self::validCodes($shifts, $kind);
            $need = max(0, (int)($needs[$kind] ?? 0));
            if ($kind === 'lv') {
                $pref = array_values(array_filter($codes, static fn($c) => ($byCode[$c]['line'] ?? 'REF') !== 'REF'));
                $rest = array_values(array_filter($codes, static fn($c) => ($byCode[$c]['line'] ?? 'REF') === 'REF'));
                $codes = array_slice(array_merge($pref, $rest), 0, $need);
            } else {
                $codes = array_slice($codes, 0, $need);
            }
            $assignedCodes = [];
            foreach ($result as $key => $value) {
                if (!is_string($key) || !str_ends_with($key, '|' . $date) || !ctype_digit((string)$value)) {
                    continue;
                }
                $assignedCodes[] = (int)$value;
            }
            $missing = array_values(array_diff($codes, array_unique($assignedCodes)));
            if (!$missing) {
                continue;
            }
            $slots = self::usedVehicleSlots($ctx, $date, $result, $vehicleResult);
            foreach ($missing as $code) {
                $shift = $byCode[(int)$code] ?? null;
                $variant = $shift['variants'][$kind] ?? null;
                if (!$shift || !$variant) {
                    continue;
                }
                $best = null;
                foreach ($drivers as $drv) {
                    $id = (string)$drv['id'];
                    $value = self::assignmentAt($result, $id, $date);
                    if ($value !== 'D' && $value !== 'X') {
                        continue;
                    }
                    if (self::absenceFor($absences, $id, $date) !== null) {
                        continue;
                    }
                    if (!empty($protectedRest[$id][$date]) || !empty($reserved[$id][$date])) {
                        continue;
                    }
                    if ($value === 'D' && ($restCounts[$id] ?? 0) <= ($restMinFor[$id] ?? $restMin)) {
                        continue;
                    }
                    $key = $id . '|' . $date;
                    if (!self::restAllowedForShift(
                        $view, $byCode, $holidays, $id, $date, (string)$code,
                        $minRest, $reducedMin, $maxReduced, $weeklyRest
                    ) || !self::streakSafeAfterMove(
                        $view, $allByCode, $holidays, $id, $date, (string)$code,
                        $maxConsecutive, $exceptionDays, $exceptionRestMin,
                        $days[0], $days[count($days) - 1]
                    )) {
                        continue;
                    }
                    $decision = self::chooseServiceVehicle(
                        $ctx, $drv, $shift, $variant, (int)$code, $kind, $date,
                        $result, $vehicleResult, $key, $slots
                    );
                    if (!$decision['ok']) {
                        continue;
                    }
                    $score = [$value === 'X' ? 1 : 0, -($restCounts[$id] ?? 0), mt_rand()];
                    if ($best === null || $score < $best['score']) {
                        $best = [
                            'id' => $id, 'value' => $value, 'vehicle' => $decision['vehicle'], 'score' => $score,
                        ];
                    }
                }
                if ($best === null) {
                    continue;
                }
                $key = $best['id'] . '|' . $date;
                $result[$key] = (string)$code;
                $view[$key] = (string)$code;
                $vehicleResult[$key] = $best['vehicle'];
                [$slotStart, $slotEnd] = self::variantMinutes($variant);
                $slots[$best['vehicle']][] = [$slotStart, $slotEnd];
                if ($best['value'] === 'D') {
                    $restCounts[$best['id']]--;
                } else {
                    $virtual = max(0, $virtual - 1);
                }
            }
        }
        /* Ajuste final de libres: como máximo tres D seguidos y ningún
           conductor por encima de los libres calculados. Se mueve el mismo
           turno desde quien tiene D de sobra (o una racha larga de D) a quien
           tiene menos libres y puede descansar ese día. */
        $polishProtectedRest = [];
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            $cursor = $days[0];
            $lastDay = $days[count($days) - 1];
            while ($cursor <= $lastDay) {
                if (!self::isWorkCode(self::assignmentAt($view, $id, $cursor))) {
                    $cursor = self::shiftDate($cursor, 1);
                    continue;
                }
                $end = $cursor;
                while ($end < $lastDay && self::isWorkCode(self::assignmentAt($view, $id, self::shiftDate($end, 1)))) {
                    $end = self::shiftDate($end, 1);
                }
                $length = (int)(new DateTimeImmutable($cursor))->diff(new DateTimeImmutable($end))->format('%a') + 1;
                if ($length >= $maxConsecutive + 1) {
                    $claims = self::claimedRests(
                        $view, $byCode, $holidays, $id, $cursor, $maxConsecutive, $exceptionDays, $exceptionRestMin
                    );
                    $before = self::restBefore($view, $byCode, $holidays, $id, $cursor);
                    $after = self::restAfter($view, $byCode, $holidays, $id, $end);
                    $chosen = null;
                    if ($before && $before['minutes'] >= $exceptionRestMin && empty($claims[$before['key']])) {
                        $chosen = $before;
                    } elseif ($after && $after['minutes'] >= $exceptionRestMin && empty($claims[$after['key']])) {
                        $chosen = $after;
                    }
                    if ($chosen) {
                        $reserveDays = max(1, (int)ceil($exceptionRestMin / 1440));
                        foreach (array_slice($chosen['dates'], 0, $reserveDays) as $restDate) {
                            $polishProtectedRest[$id][$restDate] = true;
                        }
                    }
                }
                $cursor = self::shiftDate($end, 1);
            }
        }
        $dRunAfter = static function (string $id, string $date) use (&$view): int {
            // Se mida desde el valor actual o desde el que tendrá tras el
            // movimiento: siempre se cuenta la fecha como D y sus vecinos.
            $run = 1;
            $cursor = self::shiftDate($date, -1);
            for ($i = 0; $i < 70 && self::assignmentAt($view, $id, $cursor) === 'D'; $i++, $cursor = self::shiftDate($cursor, -1)) {
                $run++;
            }
            $cursor = self::shiftDate($date, 1);
            for ($i = 0; $i < 70 && self::assignmentAt($view, $id, $cursor) === 'D'; $i++, $cursor = self::shiftDate($cursor, 1)) {
                $run++;
            }
            return $run;
        };
        for ($round = 0; $round < 2; $round++) {
            $movedAny = false;
            foreach ($drivers as $drvB) {
                $idB = (string)$drvB['id'];
                if (($availableDays[$idB] ?? 0) === 0) {
                    continue;
                }
                $targetB = $restTargetFor[$idB] ?? $restTarget;
                for ($step = 0; $step < 1; $step++) {
                    $excessB = ($restCounts[$idB] ?? 0) - $targetB;
                    $longRun = 0;
                    $dates = [];
                    foreach ($days as $date) {
                        if (self::assignmentAt($result, $idB, $date) !== 'D') {
                            continue;
                        }
                        $run = $dRunAfter($idB, $date);
                        $longRun = max($longRun, $run);
                        $dates[] = ['date' => $date, 'run' => $run];
                    }
                    if ($excessB <= 0 && $longRun < 4) {
                        break;
                    }
                    usort($dates, static fn(array $a, array $b): int =>
                        [$b['run'], $a['date']] <=> [$a['run'], $b['date']]);
                    $moved = false;
                    foreach ($dates as $option) {
                        $date = $option['date'];
                        if ($excessB <= 0 && $option['run'] < 4) {
                            continue;
                        }
                        if (self::absenceFor($absences, $idB, $date) !== null
                            || !empty($polishProtectedRest[$idB][$date])
                            || !empty($reserved[$idB][$date])) {
                            continue;
                        }
                        $kind = self::dayType($date, $holidays);
                        $keyB = $idB . '|' . $date;
                        $best = null;
                        foreach ($drivers as $drvA) {
                            $idA = (string)$drvA['id'];
                            if ($idA === $idB || self::absenceFor($absences, $idA, $date) !== null) {
                                continue;
                            }
                            $code = self::assignmentAt($result, $idA, $date);
                            if (!ctype_digit($code)) {
                                continue;
                            }
                            $shift = $byCode[(int)$code] ?? null;
                            $variant = $shift['variants'][$kind] ?? null;
                            if (!$shift || !$variant) {
                                continue;
                            }
                            // El donante puede estar ya en el objetivo: al
                            // recibir el D queda en objetivo + 1 y se volverá
                            // a nivelar en la siguiente pasada.
                            if (($restCounts[$idA] ?? 0) > ($restTargetFor[$idA] ?? $restTarget)) {
                                continue;
                            }
                            if ($dRunAfter($idA, $date) > 3) {
                                continue;
                            }
                            if (!self::restAllowedForShift(
                                $view, $byCode, $holidays, $idB, $date, $code,
                                $minRest, $reducedMin, $maxReduced, $weeklyRest
                            ) || !self::streakSafeAfterMove(
                                $view, $allByCode, $holidays, $idB, $date, $code,
                                $maxConsecutive, $exceptionDays, $exceptionRestMin,
                                $days[0], $days[count($days) - 1]
                            )) {
                                continue;
                            }
                            $keyA = $idA . '|' . $date;
                            $slots = self::usedVehicleSlots($ctx, $date, $result, $vehicleResult, $keyA);
                            $decision = self::chooseServiceVehicle(
                                $ctx, $drvB, $shift, $variant, (int)$code, $kind, $date,
                                $result, $vehicleResult, $keyB, $slots
                            );
                            if (!$decision['ok']) {
                                continue;
                            }
                            $score = [($restCounts[$idA] ?? 0), $dRunAfter($idA, $date), mt_rand()];
                            if ($best === null || $score < $best['score']) {
                                $best = [
                                    'id' => $idA, 'code' => $code,
                                    'vehicle' => $decision['vehicle'], 'score' => $score,
                                ];
                            }
                        }
                        if ($best === null) {
                            continue;
                        }
                        $keyA = $best['id'] . '|' . $date;
                        unset($vehicleResult[$keyA]);
                        $vehicleResult[$keyB] = $best['vehicle'];
                        $result[$keyB] = $best['code'];
                        $view[$keyB] = $best['code'];
                        $result[$keyA] = 'D';
                        $view[$keyA] = 'D';
                        $restCounts[$idB]--;
                        $restCounts[$best['id']]++;
                        $moved = true;
                        $movedAny = true;
                        break;
                    }
                    if (!$moved) {
                        break;
                    }
                }
            }
            if (!$movedAny) {
                break;
            }
        }
        /* Las X del plan son obligatorias: deben quedar exactamente $planX.
           Se dan a conductores con más libres de los calculados, con prioridad
           a quien más se pasa y a los días con rachas más cortas. */
        $finalProtectedRest = [];
        foreach ($drivers as $drv) {
            $id = (string)$drv['id'];
            $cursor = $days[0];
            $lastDay = $days[count($days) - 1];
            while ($cursor <= $lastDay) {
                if (!self::isWorkCode(self::assignmentAt($view, $id, $cursor))) {
                    $cursor = self::shiftDate($cursor, 1);
                    continue;
                }
                $end = $cursor;
                while ($end < $lastDay && self::isWorkCode(self::assignmentAt($view, $id, self::shiftDate($end, 1)))) {
                    $end = self::shiftDate($end, 1);
                }
                $length = (int)(new DateTimeImmutable($cursor))->diff(new DateTimeImmutable($end))->format('%a') + 1;
                if ($length >= $maxConsecutive + 1) {
                    $claims = self::claimedRests(
                        $view, $byCode, $holidays, $id, $cursor, $maxConsecutive, $exceptionDays, $exceptionRestMin
                    );
                    $before = self::restBefore($view, $byCode, $holidays, $id, $cursor);
                    $after = self::restAfter($view, $byCode, $holidays, $id, $end);
                    $chosen = null;
                    if ($before && $before['minutes'] >= $exceptionRestMin && empty($claims[$before['key']])) {
                        $chosen = $before;
                    } elseif ($after && $after['minutes'] >= $exceptionRestMin && empty($claims[$after['key']])) {
                        $chosen = $after;
                    }
                    if ($chosen) {
                        $reserveDays = max(1, (int)ceil($exceptionRestMin / 1440));
                        foreach (array_slice($chosen['dates'], 0, $reserveDays) as $restDate) {
                            $finalProtectedRest[$id][$restDate] = true;
                        }
                    }
                }
                $cursor = self::shiftDate($end, 1);
            }
        }
        $xKeys = [];
        foreach ($result as $key => $value) {
            if ($value === 'X') {
                $xKeys[] = (string)$key;
            }
        }
        $currentX = count($xKeys);
        if ($currentX < $planX) {
            $deficit = $planX - $currentX;
            while ($deficit > 0) {
                $options = [];
                foreach ($drivers as $drv) {
                    $id = (string)$drv['id'];
                    if (($availableDays[$id] ?? 0) === 0) {
                        continue;
                    }
                    $target = $restTargetFor[$id] ?? $restTarget;
                    $excess = ($restCounts[$id] ?? 0) - $target;
                    if ($excess <= 0) {
                        continue;
                    }
                    foreach ($days as $date) {
                        if (self::assignmentAt($result, $id, $date) !== 'D'
                            || self::absenceFor($absences, $id, $date) !== null) {
                            continue;
                        }
                        if (!empty($finalProtectedRest[$id][$date]) || !empty($reserved[$id][$date])) {
                            continue;
                        }
                        if (!self::streakSafeAfterMove(
                            $view, $allByCode, $holidays, $id, $date, 'X',
                            $maxConsecutive, $exceptionDays, $exceptionRestMin,
                            $days[0], $days[count($days) - 1]
                        )) {
                            continue;
                        }
                        $before = self::streakBefore($view, $id, $date);
                        $after = 0;
                        $cursor = self::shiftDate($date, 1);
                        while ($after < 70 && self::isWorkCode(self::assignmentAt($view, $id, $cursor))) {
                            $after++;
                            $cursor = self::shiftDate($cursor, 1);
                        }
                        $options[] = [
                            'id' => $id, 'date' => $date,
                            'score' => [$excess, $before['count'] + $after, $date],
                        ];
                    }
                }
                if (!$options) {
                    break;
                }
                usort($options, static fn(array $a, array $b): int =>
                    [-$a['score'][0], $a['score'][1], $a['score'][2]]
                    <=> [-$b['score'][0], $b['score'][1], $b['score'][2]]);
                $chosen = $options[0];
                $key = $chosen['id'] . '|' . $chosen['date'];
                $result[$key] = 'X';
                $view[$key] = 'X';
                $restCounts[$chosen['id']]--;
                $deficit--;
            }
        } elseif ($currentX > $planX) {
            $surplus = $currentX - $planX;
            usort($xKeys, static function (string $a, string $b) use ($result, $restCounts, $restTargetFor, $restTarget): int {
                $partsA = explode('|', $a);
                $partsB = explode('|', $b);
                $deficitA = ($restTargetFor[$partsA[0]] ?? $restTarget) - ($restCounts[$partsA[0]] ?? 0);
                $deficitB = ($restTargetFor[$partsB[0]] ?? $restTarget) - ($restCounts[$partsB[0]] ?? 0);
                return [$deficitB, $a] <=> [$deficitA, $b];
            });
            foreach ($xKeys as $key) {
                if ($surplus <= 0) {
                    break;
                }
                if (self::assignmentAt($result, explode('|', $key)[0], explode('|', $key)[1]) !== 'X') {
                    continue;
                }
                $parts = explode('|', $key);
                if ($dRunIfD($parts[0], $parts[1]) > 3) {
                    continue;
                }
                $result[$key] = 'D';
                $view[$key] = 'D';
                $restCounts[$parts[0]] = ($restCounts[$parts[0]] ?? 0) + 1;
                $surplus--;
            }
        }
        // Las cifras finales se recalculan sobre el cuadrante guardado: las
        // cesiones entre conductores no cambian el número de servicios.
        $finalGenerated = 0;
        $finalX = 0;
        foreach ($result as $value) {
            if (ctype_digit((string)$value)) {
                $finalGenerated++;
            } elseif ($value === 'X') {
                $finalX++;
            }
        }
        $finalUncovered = 0;
        foreach ($days as $date) {
            $kind = self::dayType($date, $holidays);
            $codes = self::validCodes($shifts, $kind);
            $need = max(0, (int)($needs[$kind] ?? 0));
            if ($kind === 'lv') {
                $pref = array_values(array_filter($codes, static fn($c) => ($byCode[$c]['line'] ?? 'REF') !== 'REF'));
                $rest = array_values(array_filter($codes, static fn($c) => ($byCode[$c]['line'] ?? 'REF') === 'REF'));
                $codes = array_slice(array_merge($pref, $rest), 0, $need);
            } else {
                $codes = array_slice($codes, 0, $need);
            }
            $assignedCodes = [];
            foreach ($result as $key => $value) {
                if (!is_string($key) || !str_ends_with($key, '|' . $date) || !ctype_digit((string)$value)) {
                    continue;
                }
                $assignedCodes[] = (int)$value;
            }
            $finalUncovered += count(array_diff($codes, array_unique($assignedCodes)));
        }
        $virtual = $finalX;

        $db['assignments'][$month] = $result;
        $db['vehicleAssignments'][$month] = $vehicleResult;
        $this->write($db);
        return [
            'db' => $db,
            'stats' => [
                'generated' => $finalGenerated,
                'reassigned' => $reassigned,
                'uncovered' => $finalUncovered,
                'paired' => $paired,
                'crossGroup' => $crossGroup,
                'virtual' => $finalX,
            ],
        ];
    }
}
