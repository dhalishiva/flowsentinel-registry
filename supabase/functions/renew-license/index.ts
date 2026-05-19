// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function sha256hex(text: string): Promise<string> {
  const buf  = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromBase64Url(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded  = base64 + '='.repeat((4 - base64.length % 4) % 4);
  return atob(padded);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { license_key, company_code: rawCode } = await req.json();

    if (!license_key || !rawCode) {
      return json({ success: false, error: 'license_key and company_code are required' }, 400);
    }

    const company_code = rawCode.toUpperCase().trim();
    if (!/^[A-Z0-9]{4}$/.test(company_code)) {
      return json({ success: false, error: 'Invalid company code format' }, 400);
    }

    const secret = Deno.env.get('LICENSE_HMAC_SECRET');
    if (!secret) {
      return json({ success: false, error: 'Server configuration error' }, 500);
    }

    // ── Decode + verify the new key (identical logic to validate-license) ──
    const cleaned = license_key.trim()
      .replace(/^FS\./i, '')
      .replace(/\./g, '');

    let combined: string;
    try {
      combined = fromBase64Url(cleaned);
    } catch {
      return json({ success: false, error: 'Invalid license key format' }, 400);
    }

    const pipeIndex = combined.lastIndexOf('|');
    if (pipeIndex === -1) {
      return json({ success: false, error: 'Invalid license key format' }, 400);
    }

    const payloadB64 = combined.slice(0, pipeIndex);
    const signature  = combined.slice(pipeIndex + 1);
    const expectedSig = await hmacSha256hex(payloadB64, secret);

    if (expectedSig !== signature) {
      return json({
        success: false,
        error: 'Invalid license key. Please check the key and try again.',
      }, 400);
    }

    let payload: { type: string; max_mailboxes: number; expires_at: string; issued_at: string };
    try {
      payload = JSON.parse(fromBase64Url(payloadB64));
    } catch {
      return json({ success: false, error: 'Invalid license key' }, 400);
    }

    // New key must have a future expiry
    if (new Date(payload.expires_at) < new Date()) {
      return json({
        success: false,
        error: 'This license key has already expired. Please contact sales@supportu.cloud.',
      }, 400);
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const newKeyHash = await sha256hex(cleaned);

    // ── Guard: new key must not already be activated elsewhere ────────────
    const { data: alreadyUsed } = await adminClient
      .from('licenses')
      .select('id, activated_at, tenant_id')
      .eq('license_key_hash', newKeyHash)
      .maybeSingle();

    if (alreadyUsed?.activated_at) {
      return json({
        success: false,
        error: 'This license key has already been activated.',
      }, 400);
    }

    // ── Look up the tenant by company_code ────────────────────────────────
    const { data: tenant, error: tenantErr } = await adminClient
      .from('tenants')
      .select('id, company_name, company_code, contact_email, is_active')
      .eq('company_code', company_code)
      .single();

    if (tenantErr || !tenant) {
      return json({
        success: false,
        error: `No tenant found with company code "${company_code}".`,
      }, 404);
    }

    if (!tenant.is_active) {
      return json({
        success: false,
        error: 'This tenant account is inactive. Contact support.',
      }, 403);
    }

    // ── Find the current active license row for this tenant ───────────────
    const { data: currentLicense } = await adminClient
      .from('licenses')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .is('superseded_at', null)
      .order('activated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const now = new Date().toISOString();

    // ── Option B: mark old license superseded, insert new row ─────────────
    if (currentLicense) {
      const { error: supersedeErr } = await adminClient
        .from('licenses')
        .update({ is_active: false, superseded_at: now })
        .eq('id', currentLicense.id);

      if (supersedeErr) {
        throw new Error(`Failed to supersede old license: ${supersedeErr.message}`);
      }
    }

    const { error: insertErr } = await adminClient
      .from('licenses')
      .insert({
        tenant_id:          tenant.id,
        license_key_hash:   newKeyHash,
        license_key_prefix: cleaned.slice(0, 6),
        license_type:       payload.type,
        max_mailboxes:      payload.max_mailboxes,
        expires_at:         payload.expires_at,
        activated_at:       now,
        is_active:          true,
      });

    if (insertErr) {
      // If insert failed, try to restore the old license to avoid leaving
      // the tenant in a state with no active license row.
      if (currentLicense) {
        await adminClient
          .from('licenses')
          .update({ is_active: true, superseded_at: null })
          .eq('id', currentLicense.id);
      }
      throw new Error(`Failed to create new license: ${insertErr.message}`);
    }

    console.log('✓ Renewal successful:', company_code, payload.type, payload.expires_at);

    return json({
      success:       true,
      company_code,
      company_name:  tenant.company_name,
      license_type:  payload.type,
      max_mailboxes: payload.max_mailboxes,
      expires_at:    payload.expires_at,
    });

  } catch (err) {
    console.error('Unhandled error:', (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});