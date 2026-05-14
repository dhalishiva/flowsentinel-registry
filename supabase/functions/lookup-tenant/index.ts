// deno-lint-ignore-file
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const { company_code } = await req.json();
    if (!company_code || typeof company_code !== 'string') {
      return json({ success: false, error: 'company_code required' }, 400);
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Find the tenant
    const { data: tenant, error } = await adminClient
      .from('tenants')
      .select('id, company_name, company_code, supabase_url, supabase_anon_key, is_active')
      .ilike('company_code', company_code.trim())
      .single();

    if (error || !tenant) {
      return json({ success: false, error: 'Company code not found. Check your code or contact your administrator.' }, 404);
    }

    if (!tenant.is_active) {
      return json({ success: false, error: 'This account is inactive. Please contact sales@supportu.cloud.' }, 403);
    }

    // Check if they have a valid non-expired license
    const { data: license } = await adminClient
      .from('licenses')
      .select('id, license_type, expires_at, max_mailboxes, is_active')
      .eq('tenant_id', tenant.id)
      .eq('is_active', true)
      .gte('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .limit(1)
      .single();

    if (!license) {
      return json({
        success: false,
        error: 'Your license has expired or is inactive. Please contact sales@supportu.cloud to renew.',
        license_expired: true,
      }, 403);
    }

    return json({
      success: true,
      company_name: tenant.company_name,
      company_code: tenant.company_code,
      supabase_url: tenant.supabase_url,
      supabase_anon_key: tenant.supabase_anon_key,
      license: {
        type: license.license_type,
        expires_at: license.expires_at,
        max_mailboxes: license.max_mailboxes,
      },
    });
  } catch (err) {
    return json({ success: false, error: (err as Error).message }, 500);
  }
});