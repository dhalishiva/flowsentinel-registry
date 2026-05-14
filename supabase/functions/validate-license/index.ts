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
  const buf = new TextEncoder().encode(text);
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
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message)
  );
  return Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromBase64Url(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  return atob(padded);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const {
      license_key,
      supabase_url,
      supabase_anon_key,
      company_name,
      contact_email,
      company_code: rawCode,
    } = await req.json();

    if (!license_key || !supabase_url || !supabase_anon_key ||
        !company_name || !contact_email || !rawCode) {
      return json({ success: false, error: 'All fields are required' }, 400);
    }

    // Validate company code
    const company_code = rawCode.toUpperCase().trim();
    if (!/^[A-Z0-9]{4}$/.test(company_code)) {
      return json({
        success: false,
        error: 'Company code must be exactly 4 letters or numbers (e.g. ACEK)',
      }, 400);
    }

    const secret = Deno.env.get('LICENSE_HMAC_SECRET');
    if (!secret) {
      return json({
        success: false,
        error: 'Server configuration error: LICENSE_HMAC_SECRET not set',
      }, 500);
    }

    // Clean the key:
    // 1. Remove FS. prefix
    // 2. Remove ALL dots (our separators — safe because dots are not in base64url)
    const cleaned = license_key.trim()
      .replace(/^FS\./i, '')
      .replace(/\./g, '');

    console.log('Cleaned length:', cleaned.length);
    console.log('Cleaned (first 20):', cleaned.slice(0, 20));

    // Decode the outer base64url to get "payloadB64|signature"
    let combined: string;
    try {
      combined = fromBase64Url(cleaned);
    } catch (e) {
      console.error('Outer decode failed:', (e as Error).message);
      return json({ success: false, error: 'Invalid license key format' }, 400);
    }

    console.log('Combined (first 40):', combined.slice(0, 40));

    // Split on pipe separator
    const pipeIndex = combined.lastIndexOf('|');
    if (pipeIndex === -1) {
      console.error('No pipe separator found');
      return json({ success: false, error: 'Invalid license key format' }, 400);
    }

    const payloadB64 = combined.slice(0, pipeIndex);
    const signature  = combined.slice(pipeIndex + 1);

    console.log('PayloadB64 (first 20):', payloadB64.slice(0, 20));
    console.log('Signature (first 10):', signature.slice(0, 10));

    // Verify HMAC
    const expectedSig = await hmacSha256hex(payloadB64, secret);

    console.log('Expected  (first 10):', expectedSig.slice(0, 10));
    console.log('Match:', expectedSig === signature);

    if (expectedSig !== signature) {
      return json({
        success: false,
        error: 'Invalid license key. Please check the key and try again.',
      }, 400);
    }

    // Decode payload JSON
    let payloadJson: string;
    try {
      payloadJson = fromBase64Url(payloadB64);
    } catch (e) {
      return json({ success: false, error: 'Invalid license key' }, 400);
    }

    let payload: {
      type: string;
      max_mailboxes: number;
      expires_at: string;
      issued_at: string;
    };
    try {
      payload = JSON.parse(payloadJson);
    } catch (e) {
      return json({ success: false, error: 'Invalid license key' }, 400);
    }

    console.log('Payload:', payload.type, payload.max_mailboxes, 'mailboxes');

    // Check expiry
    if (new Date(payload.expires_at) < new Date()) {
      return json({
        success: false,
        error: 'This license key has expired. Please contact sales@supportu.cloud.',
      }, 400);
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const keyHash = await sha256hex(cleaned);

    // Check if already activated
    const { data: existingLicense } = await adminClient
      .from('licenses')
      .select('id, activated_at, tenant_id')
      .eq('license_key_hash', keyHash)
      .single();

    if (existingLicense?.activated_at) {
      return json({
        success: false,
        error: 'This license key has already been activated.',
      }, 400);
    }

    // Check company code availability
    const { data: codeConflict } = await adminClient
      .from('tenants').select('id').eq('company_code', company_code).single();

    if (codeConflict) {
      return json({
        success: false,
        error: `Company code "${company_code}" is already taken. Please choose a different 4-character code.`,
      }, 400);
    }

    // Create tenant
    const { data: tenant, error: tenantErr } = await adminClient
      .from('tenants')
      .insert({
        company_name,
        company_code,
        supabase_url: supabase_url.replace(/\/$/, ''),
        supabase_anon_key,
        contact_email,
        is_active: true,
      })
      .select().single();

    if (tenantErr) throw new Error(`Failed to create tenant: ${tenantErr.message}`);

    // Create license record
    if (existingLicense) {
      await adminClient.from('licenses').update({
        tenant_id: tenant.id,
        activated_at: new Date().toISOString(),
      }).eq('id', existingLicense.id);
    } else {
      const { error: licErr } = await adminClient.from('licenses').insert({
        tenant_id: tenant.id,
        license_key_hash: keyHash,
        license_key_prefix: cleaned.slice(0, 6),
        license_type: payload.type,
        max_mailboxes: payload.max_mailboxes,
        expires_at: payload.expires_at,
        activated_at: new Date().toISOString(),
        is_active: true,
      });
      if (licErr) {
        await adminClient.from('tenants').delete().eq('id', tenant.id);
        throw new Error(`Failed to create license: ${licErr.message}`);
      }
    }

    console.log('✓ Activation successful:', company_code);

    return json({
      success: true,
      company_code,
      company_name,
      license_type: payload.type,
      max_mailboxes: payload.max_mailboxes,
      expires_at: payload.expires_at,
    });

  } catch (err) {
    console.error('Unhandled error:', (err as Error).message);
    return json({ success: false, error: (err as Error).message }, 500);
  }
});