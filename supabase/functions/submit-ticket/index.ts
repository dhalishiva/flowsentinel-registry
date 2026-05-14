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
    const {
      company_code, submitted_by_email, submitted_by_name,
      subject, description, priority, category,
    } = await req.json();

    if (!company_code || !submitted_by_email || !subject || !description) {
      return json({ success: false, error: 'company_code, submitted_by_email, subject, and description are required' }, 400);
    }

    const validPriorities = ['low', 'medium', 'high', 'critical'];
    const validCategories = ['technical', 'billing', 'feature_request', 'other'];

    if (priority && !validPriorities.includes(priority)) {
      return json({ success: false, error: 'Invalid priority' }, 400);
    }
    if (category && !validCategories.includes(category)) {
      return json({ success: false, error: 'Invalid category' }, 400);
    }

    const adminClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Verify the company code exists and is active
    const { data: tenant } = await adminClient
      .from('tenants')
      .select('id, company_name, is_active')
      .ilike('company_code', company_code)
      .single();

    if (!tenant || !tenant.is_active) {
      return json({ success: false, error: 'Invalid company code' }, 403);
    }

    const { data: ticket, error } = await adminClient
      .from('support_tickets')
      .insert({
        tenant_id: tenant.id,
        company_code: company_code.toUpperCase(),
        submitted_by_email,
        submitted_by_name: submitted_by_name || null,
        subject,
        description,
        priority: priority || 'medium',
        category: category || 'technical',
        status: 'open',
      })
      .select()
      .single();

    if (error) throw new Error(`Failed to create ticket: ${error.message}`);

    return json({ success: true, ticket_id: ticket.id });
  } catch (err) {
    return json({ success: false, error: (err as Error).message }, 500);
  }
});