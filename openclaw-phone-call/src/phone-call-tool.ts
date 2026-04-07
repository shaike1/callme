import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../../../src/plugins/types.js";

type PluginCfg = {
  voiceServerUrl?: string;
  defaultDevice?: string;
  username?: string;
  password?: string;
};

export function createPhoneCallTool(api: OpenClawPluginApi) {
  return {
    name: "phone-call",
    description:
      "Make an outbound phone call via the CallMe voice server. " +
      "The 'to' field accepts E.164 phone numbers (+15551234567) or internal 3CX extensions (e.g. 12610).",

    parameters: Type.Object({
      to: Type.String({
        description: "Phone number or extension to call (E.164 like +972501234567, or internal extension like 12610).",
      }),
      device: Type.Optional(
        Type.String({
          description:
            "Caller extension to use (e.g. '12611'). Uses plugin default if not specified.",
        }),
      ),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const pluginCfg = (api.pluginConfig ?? {}) as PluginCfg;

      const voiceServerUrl =
        (typeof pluginCfg.voiceServerUrl === "string" && pluginCfg.voiceServerUrl.trim()) ||
        "http://YOUR_SERVER_LAN_IP:3000";

      const to = typeof params.to === "string" ? params.to.trim() : "";
      if (!to) {
        throw new Error("'to' is required");
      }

      const device =
        (typeof params.device === "string" && params.device.trim()) ||
        (typeof pluginCfg.defaultDevice === "string" && pluginCfg.defaultDevice.trim()) ||
        undefined;

      const body: Record<string, unknown> = { to };
      if (device) body.callerId = device;

      const authHeaders: Record<string, string> = {};
      if (pluginCfg.username && pluginCfg.password) {
        const token = Buffer.from(`${pluginCfg.username}:${pluginCfg.password}`).toString("base64");
        authHeaders["Authorization"] = `Basic ${token}`;
      }

      let callId: string;
      let callStatus: string;

      // Initiate the call
      try {
        const response = await fetch(`${voiceServerUrl}/call`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(body),
        });

        const data = (await response.json()) as {
          success: boolean;
          callId?: string;
          status?: string;
          error?: string;
          message?: string;
        };

        if (!response.ok || !data.success) {
          const errMsg = data.message ?? data.error ?? `HTTP ${response.status}`;
          throw new Error(`Voice server rejected call: ${errMsg}`);
        }

        callId = data.callId ?? "unknown";
        callStatus = data.status ?? "queued";
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to initiate call: ${msg}`);
      }

      const summary = `Outbound call initiated to ${to}. Call ID: ${callId}. Status: ${callStatus}.`;

      return {
        content: [{ type: "text", text: summary }],
        details: {
          callId,
          to,
          device: device ?? null,
          status: callStatus,
          voiceServerUrl,
        },
      };
    },
  };
}
