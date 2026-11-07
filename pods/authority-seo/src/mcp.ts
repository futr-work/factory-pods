/**
 * Cloudflare Workers Model Context Protocol (MCP) Server v2
 * Spec: 2026-07-28 (Stateless Core, Tasks Extension, Resources, and Tool Calling)
 * Reference: https://blog.cloudflare.com/mcp-v2
 */

import { toPodStorage, PodStorage } from "@futr-work/pod-kernel/storage";
import { activeHandler, AuthoritySeoPodHandler } from "./handler.js";
import { OrreryConnector } from "./orrery-connector.js";
import { PodConfig } from "./types.js";

export const MCP_V2_PROTOCOL_VERSION = "2026-07-28";
export const MCP_V1_PROTOCOL_VERSION = "2024-11-05";

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: any;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

const MCP_TOOLS = [
  {
    name: "audit_site",
    description: "Execute a technical SEO & AEO audit on a target URL using Orrery's 16-check crawler and citation gap classifier.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL of the target site (e.g. 'https://clinic.example.com/')",
        },
        maxPages: {
          type: "number",
          description: "Maximum pages to sample (default: 10)",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "generate_ai_robots_txt",
    description: "Generate a 2026 AI Search Engine & Web Crawler Governance robots.txt policy that permits citation engines (PerplexityBot, OAI-SearchBot, Claude-Web) while gating model training scrapers (GPTBot, CCBot, Bytespider).",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain name (e.g. 'clinic.example.com')",
        },
        sitemapUrl: {
          type: "string",
          description: "Optional full URL to the sitemap XML",
        },
        allowAiSearch: {
          type: "boolean",
          description: "Allow LLM citation & direct answer bots (default: true)",
        },
        allowAiTraining: {
          type: "boolean",
          description: "Allow bulk dataset training scrapers (default: false)",
        },
      },
      required: ["domain"],
    },
  },
  {
    name: "generate_schema_jsonld",
    description: "Generate valid Schema.org JSON-LD structured data for Google Knowledge Graph and entity recognition.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["Organization", "MedicalBusiness", "LocalBusiness", "WebSite", "Article", "FAQPage"],
          description: "Schema.org entity type",
        },
        name: {
          type: "string",
          description: "Organization or entity brand name",
        },
        domain: {
          type: "string",
          description: "Domain name",
        },
        url: {
          type: "string",
          description: "Canonical entity URL",
        },
        description: {
          type: "string",
          description: "Entity description",
        },
        details: {
          type: "object",
          description: "Additional details (phone, address, author, medicalSpecialty, services)",
        },
      },
      required: ["type", "name", "url"],
    },
  },
  {
    name: "optimize_metadata",
    description: "Audit and optimize title tags (<= 60 chars) and meta descriptions (<= 155 chars) with target keyword alignment.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Current page title",
        },
        description: {
          type: "string",
          description: "Current page meta description",
        },
        targetKeyword: {
          type: "string",
          description: "Primary keyword phrase to align",
        },
        url: {
          type: "string",
          description: "Page URL",
        },
      },
      required: ["title", "description", "targetKeyword"],
    },
  },
  {
    name: "generate_sample_fixpack",
    description: "Generate the complete production-ready SEO/AEO fix pack for Example Clinic (AI robots.txt, MedicalBusiness Schema, and metadata).",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "submit_indexnow",
    description: "Submit URLs to the IndexNow protocol (Bing, Yandex, Seznam) for instant web search crawling and indexing.",
    inputSchema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "Domain name (default: 'clinic.example.com')",
        },
        urls: {
          type: "array",
          items: { type: "string" },
          description: "List of absolute URLs to submit",
        },
        key: {
          type: "string",
          description: "Optional IndexNow key (defaults to configured key)",
        },
      },
    },
  },
  {
    name: "search_google_serp",
    description: "Perform real-time Google search engine ranking and SERP analysis via Serper.dev API.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search keyword query (e.g. 'GLP-1 medical weight loss online')",
        },
        num: {
          type: "number",
          description: "Number of search results to retrieve (default: 10)",
        },
        country: {
          type: "string",
          description: "Target search country code (default: 'us')",
        },
      },
      required: ["query"],
    },
  },
];

const MCP_RESOURCES = [
  {
    uri: "seo://Example Clinic/robots.txt",
    name: "Example Clinic AI Crawler Governance Policy",
    description: "Latest 2026 AI Search & Crawler Governance policy for Example Clinic.",
    mimeType: "text/plain",
  },
  {
    uri: "seo://Example Clinic/schema.jsonld",
    name: "Example Clinic Primary MedicalBusiness Schema",
    description: "Verified Schema.org MedicalBusiness structured data for Example Clinic.",
    mimeType: "application/ld+json",
  },
];

export async function handleMcpRequest(
  request: Request,
  env: Record<string, any>,
  config: PodConfig
): Promise<Response> {
  const method = request.method;
  const clientVersion = request.headers.get("Mcp-Version") || MCP_V2_PROTOCOL_VERSION;
  const activeProtocolVersion = clientVersion.startsWith("2024") ? MCP_V1_PROTOCOL_VERSION : MCP_V2_PROTOCOL_VERSION;

  const mcpHeaders = {
    "Content-Type": "application/json; charset=utf-8",
    "Mcp-Version": activeProtocolVersion,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Version",
  };

  if (method === "GET") {
    // Discovery / capability overview for MCP v2
    return new Response(
      JSON.stringify({
        mcpVersion: activeProtocolVersion,
        server: {
          name: config.id,
          role: config.role,
          lob: config.lob,
          version: "2.0.0",
        },
        capabilities: {
          tools: { listChanged: false },
          tasks: { cancel: true, list: true },
          resources: { subscribe: false },
        },
        tools: MCP_TOOLS,
        resources: MCP_RESOURCES,
      }),
      { status: 200, headers: mcpHeaders }
    );
  }

  if (method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: mcpHeaders });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: Invalid JSON" },
      }),
      { status: 400, headers: mcpHeaders }
    );
  }

  // Support batch JSON-RPC requests (MCP v2 requirement)
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map((singleReq) => processSingleRpc(singleReq, env, config, activeProtocolVersion)));
    return new Response(JSON.stringify(responses), { status: 200, headers: mcpHeaders });
  }

  const response = await processSingleRpc(body, env, config, activeProtocolVersion);
  return new Response(JSON.stringify(response), { status: 200, headers: mcpHeaders });
}

async function processSingleRpc(
  req: JsonRpcRequest,
  env: Record<string, any>,
  config: PodConfig,
  protocolVersion: string
): Promise<JsonRpcResponse> {
  const { jsonrpc, id = null, method: rpcMethod, params = {} } = req;

  if (jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" },
    };
  }

  // 1. Initialize (v2 returns 2026-07-28 and tasks capability)
  if (rpcMethod === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
          tasks: { cancel: true, list: true },
          resources: { subscribe: false },
        },
        serverInfo: {
          name: "authority-seo-pod",
          version: "2.0.0",
        },
      },
    };
  }

  // 2. Notifications
  if (rpcMethod.startsWith("notifications/")) {
    return { jsonrpc: "2.0", id, result: {} };
  }

  // 3. Tools List
  if (rpcMethod === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  // 4. Tools Call
  if (rpcMethod === "tools/call") {
    const toolName = params.name;
    const args = params.arguments || {};
    const handler = activeHandler as AuthoritySeoPodHandler;
    const orrery = new OrreryConnector(env as any);

    try {
      let resultData: any;

      switch (toolName) {
        case "audit_site": {
          const url = args.url;
          if (!url) throw new Error("url argument is required");
          resultData = await orrery.auditDomain(url, { sampleCap: args.maxPages ?? 10 });
          break;
        }

        case "generate_ai_robots_txt": {
          resultData = handler.generateRobotsTxt(args);
          break;
        }

        case "generate_schema_jsonld": {
          resultData = handler.generateSchemaJsonLd(args);
          break;
        }

        case "optimize_metadata": {
          resultData = handler.auditAndOptimizeMeta(args);
          break;
        }

        case "generate_sample_fixpack": {
          resultData = handler.generateSampleFixpack();
          break;
        }

        case "submit_indexnow": {
          resultData = await handler.submitIndexNow(args, {
            env,
            podConfig: config,
            now: Date.now(),
            publishEvent: async () => {},
          });
          break;
        }

        case "search_google_serp": {
          resultData = await handler.searchGoogleSerp(args, {
            env,
            podConfig: config,
            now: Date.now(),
            publishEvent: async () => {},
          });
          break;
        }

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method or tool not found: ${toolName}` },
          };
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: typeof resultData === "string" ? resultData : JSON.stringify(resultData, null, 2),
            },
          ],
        },
      };
    } catch (toolErr: any) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: toolErr.message || "Tool execution failed" },
      };
    }
  }

  // 5. Tasks Extension (MCP v2 Tasks)
  const db: PodStorage | undefined = env.DB ? toPodStorage(env.DB) : undefined;

  if (rpcMethod === "tasks/list") {
    let tasks: any[] = [];
    if (db) {
      try {
        const rows = await db.prepare(
          `SELECT task_id, topic, status, created_at, updated_at FROM tasks ORDER BY created_at DESC LIMIT ?`
        )
          .bind(params.limit || 20)
          .all<any>();
        tasks = rows.results || [];
      } catch (err: any) {
        console.warn(`[MCP Tasks] D1 read error: ${err.message}`);
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      result: { tasks },
    };
  }

  if (rpcMethod === "tasks/get") {
    const taskId = params.taskId;
    let task = null;
    if (db && taskId) {
      try {
        task = await db.prepare(`SELECT * FROM tasks WHERE task_id = ? LIMIT 1`)
          .bind(taskId)
          .first();
      } catch (err: any) {
        console.warn(`[MCP Tasks] D1 read error: ${err.message}`);
      }
    }
    return {
      jsonrpc: "2.0",
      id,
      result: { task },
    };
  }

  // 6. Resources Extension (MCP v2 Resources)
  if (rpcMethod === "resources/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        resources: MCP_RESOURCES,
      },
    };
  }

  if (rpcMethod === "resources/read") {
    const uri = params.uri;
    const handler = activeHandler as AuthoritySeoPodHandler;

    if (uri === "seo://Example Clinic/robots.txt") {
      const robots = handler.generateRobotsTxt({
        domain: "clinic.example.com",
        sitemapUrl: "https://clinic.example.com/sitemap.xml",
      });
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [{ uri, mimeType: "text/plain", text: robots.robotsTxt }],
        },
      };
    }

    if (uri === "seo://Example Clinic/schema.jsonld") {
      const fixpack = handler.generateSampleFixpack();
      return {
        jsonrpc: "2.0",
        id,
        result: {
          contents: [{ uri, mimeType: "application/ld+json", text: JSON.stringify(fixpack.schemaOrgJsonLd, null, 2) }],
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32602, message: `Resource not found: ${uri}` },
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unknown method: ${rpcMethod}` },
  };
}
