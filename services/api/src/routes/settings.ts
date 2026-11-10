import { withRetry, type Sql } from '@pbx/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth.js';
import { withDoc } from '../openapi/document.js';
import { tenantOf } from '../tenancy.js';

// Account settings the phone system acts on (backend step 7): add-ons and plan allowances from
// tenant_settings (docs/telephony-contract.md §9).
//
// GET /settings   any user   200 settings
//
// Read-only on purpose. Call recording and international calling are paid add-ons
// (docs/billing-flows.md §2-§3): turning one on is a purchase (prorated charge, then the flag), and
// turning it off keeps it until the paid period ends. Both belong to the add-on purchase routes
// (not built yet), not to a free toggle here. CLAUDE.md §11's `PUT /settings {record_calls}`
// predates the course spec.

const SettingsSchema = z
  .object({
    recordCalls: z.boolean().describe('Call recording add-on active: connected calls are recorded (GET /calls/{callId}/recording).'),
    intlCalling: z.boolean().describe('International calling add-on active. Without it, calls outside the US (including other +1 countries) are blocked.'),
    includedUsMinutes: z.number().int().describe('US minutes included per billing period (shared by the account).'),
    includedExtensions: z.number().int().describe('Extensions included in the plan.'),
    extraExtensions: z.number().int().describe('Additional extensions bought.'),
  })
  .describe('Add-ons and plan allowances.');

type Settings = z.infer<typeof SettingsSchema>;

/** An account without a tenant_settings row has nothing active (the column defaults). */
const DEFAULTS: Settings = {
  recordCalls: false,
  intlCalling: false,
  includedUsMinutes: 0,
  includedExtensions: 0,
  extraExtensions: 0,
};

export const settingsRoutes: FastifyPluginAsync<{ sql: Sql }> = async (app, { sql }) => {
  app.get(
    '/settings',
    withDoc(
      { preHandler: [authenticate] },
      {
        tag: 'Settings',
        auth: 'user',
        summary: 'Get account settings',
        description:
          'Active add-ons (call recording, international calling) and plan allowances. Read-only: add-ons are ' +
          'bought and cancelled through billing.',
        responses: { 200: { description: 'The settings', schema: SettingsSchema } },
      },
    ),
    async (req) => {
      const [row] = await withRetry(
        () => sql<Settings[]>`
          select record_calls, intl_calling, included_us_minutes, included_extensions, extra_extensions
            from tenant_settings where tenant_id = ${tenantOf(req)}`,
      );
      return row ?? DEFAULTS;
    },
  );
};
