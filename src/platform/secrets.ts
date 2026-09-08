export interface StoredSecret {
  name: string;
  value: string;
  description?: string;
}

export interface SecretPatch {
  name: string;
  value?: string;
  description?: string;
  delete?: boolean;
}

export interface SecretRef {
  name: string;
  envName: string;
  description?: string;
}

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const SENSITIVE_KEY_RE = /^(.*(api_?key|apikey|token|secret|password|passwd|credential|authorization|cookie).*)$/i;

export function normalizeSecretName(name: string): string {
  return name.trim().toUpperCase();
}

export function validateSecretName(name: string): boolean {
  return SECRET_NAME_RE.test(name);
}

export function mergeSecretPatches(
  current: readonly StoredSecret[] | undefined,
  patches: readonly SecretPatch[],
): StoredSecret[] {
  const byName = new Map<string, {
    value: string;
    description?: string;
  }>();

  for (const item of current ?? []) {
    const name = normalizeSecretName(item.name);
    if (validateSecretName(name)) {
      byName.set(name, {
        value: String(item.value ?? ''),
        description: cleanDescription(item.description),
      });
    }
  }

  for (const patch of patches) {
    const name = normalizeSecretName(patch.name);
    if (!validateSecretName(name)) {
      throw new Error(`Secret 名称只能使用大写字母、数字和下划线: ${patch.name}`);
    }
    if (patch.delete) {
      byName.delete(name);
      continue;
    }

    const nextDescription =
      patch.description !== undefined ? cleanDescription(patch.description) : undefined;

    if (patch.value !== undefined && patch.value !== '') {
      const existing = byName.get(name);
      byName.set(name, {
        value: String(patch.value),
        description: nextDescription ?? existing?.description,
      });
      continue;
    }
    if (!byName.has(name)) {
      byName.set(name, {
        value: '',
        description: nextDescription,
      });
      continue;
    }
    if (patch.description !== undefined) {
      const existing = byName.get(name)!;
      byName.set(name, {
        ...existing,
        description: patch.description !== undefined ? nextDescription : existing.description,
      });
    }
  }

  return Array.from(byName.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, item]) => {
      const out: StoredSecret = { name, value: item.value };
      if (item.description) out.description = item.description;
      return out;
    });
}

export function secretEnvName(name: string): string {
  return `BASEAGENT_SECRET_${normalizeSecretName(name)}`;
}

export function buildSecretEnv(secrets: readonly StoredSecret[] | undefined): Record<string, string> {
  void secrets;
  return {};
}

export function secretNames(secrets: readonly StoredSecret[] | undefined): string[] {
  return (secrets ?? [])
    .map(s => normalizeSecretName(s.name))
    .filter(validateSecretName)
    .sort();
}

export function secretRefs(secrets: readonly StoredSecret[] | undefined): SecretRef[] {
  return (secrets ?? [])
    .map(s => {
      const name = normalizeSecretName(s.name);
      return {
        name,
        envName: secretEnvName(name),
        description: cleanDescription(s.description),
      };
    })
    .filter(s => validateSecretName(s.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function redactSecrets(value: unknown, secrets: readonly StoredSecret[] | undefined): unknown {
  const values = (secrets ?? [])
    .map(s => String(s.value ?? ''))
    .filter(v => v.length >= 6);
  return redactValues(value, values);
}

export function redactValues(value: unknown, values: readonly string[]): unknown {
  return redactValuesInner(value, values);
}

export function redactSensitive(value: unknown, values: readonly string[] = []): unknown {
  return redactValuesInner(value, values);
}

function redactValuesInner(value: unknown, values: readonly string[]): unknown {
  if (typeof value === 'string') {
    let out = value;
    for (const secret of values) {
      out = out.split(secret).join(maskSecret(secret));
    }
    return out;
  }

  if (Array.isArray(value)) return value.map(v => redactValuesInner(v, values));

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveScalarKey(k, v)
        ? '<secret:field-redacted>'
        : redactValuesInner(v, values);
    }
    return out;
  }

  return value;
}

function isSensitiveScalarKey(key: string, value: unknown): boolean {
  return !!key && SENSITIVE_KEY_RE.test(key) && typeof value === 'string' && value.length > 0;
}

function maskSecret(secret: string): string {
  if (secret.length <= 10) return '<secret:redacted>';
  return `<secret:${secret.slice(0, 3)}...${secret.slice(-4)}>`;
}

function cleanDescription(description: unknown): string | undefined {
  if (typeof description !== 'string') return undefined;
  const cleaned = description.trim().replace(/\s+/g, ' ');
  return cleaned || undefined;
}
