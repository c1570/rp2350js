/**
 * MCP (Model Context Protocol) transport shim for the RP2350 emulator.
 *
 * Wraps EmulatorController (src/utils/emulator-controller.ts) — the reusable
 * engine that implements every tool via handleToolCall() — with a thin
 * createServer() method that registers them with the MCP SDK.
 *
 * The 20 per-tool description strings live in TOOL_DESCRIPTIONS (re-exported
 * from emulator-controller.ts) so the CLI transport reads the same prose.
 * Only the JSON-Schema `inputSchema` definitions (the MCP-specific arg
 * typing) live here.
 *
 * Usage:
 *   const mcp = new RP2350McpServer(); // optional bootrom Uint32Array arg
 *   const transport = new StdioServerTransport();
 *   await mcp.createServer().connect(transport);
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "rp2350": {
 *         "command": "npx",
 *         "args": ["ts-node", "demo/mcp-server.ts"]
 *       }
 *     }
 *   }
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { EmulatorController, TOOL_DESCRIPTIONS } from '../utils/emulator-controller';

// Backwards-compatible alias: the class historically exported as
// RP2350McpServer. The shim subclass preserves that name for existing
// external configs while inheriting all of EmulatorController's behaviour.
export class RP2350McpServer extends EmulatorController {
  createServer(): Server {
    const server = new Server(
      { name: 'rp2350-mcp-server', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'get_status',
          description: TOOL_DESCRIPTIONS.get_status,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'read_registers',
          description: TOOL_DESCRIPTIONS.read_registers,
          inputSchema: {
            type: 'object',
            properties: {
              core: {
                type: ['number', 'string'],
                enum: [0, 1],
                default: 0,
                description: 'Core index (0 or 1; accepts decimal or "0x...")',
              },
            },
          },
        },
        {
          name: 'write_register',
          description: TOOL_DESCRIPTIONS.write_register,
          inputSchema: {
            type: 'object',
            properties: {
              core: {
                type: ['number', 'string'],
                enum: [0, 1],
                default: 0,
                description: 'Core index (0 or 1; accepts decimal or "0x...")',
              },
              register: {
                type: 'string',
                description: 'Register name (x0-x31, ra, sp, pc, mstatus, etc.)',
              },
              value: {
                type: ['number', 'string'],
                description: '32-bit unsigned value (decimal or "0x..." hex)',
              },
            },
            required: ['register', 'value'],
          },
        },
        {
          name: 'read_memory',
          description: TOOL_DESCRIPTIONS.read_memory,
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: ['number', 'string'],
                description: 'Memory address (decimal or "0x..." hex)',
              },
              length: {
                type: ['number', 'string'],
                description: 'Number of bytes to read (decimal or "0x..." hex)',
                default: 32,
              },
            },
            required: ['address'],
          },
        },
        {
          name: 'write_memory',
          description: TOOL_DESCRIPTIONS.write_memory,
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: ['number', 'string'],
                description: 'Memory address (decimal or "0x..." hex)',
              },
              hex: { type: 'string', description: 'Hex-encoded bytes, e.g. "efbeadde"' },
            },
            required: ['address', 'hex'],
          },
        },
        {
          name: 'single_step',
          description: TOOL_DESCRIPTIONS.single_step,
          inputSchema: {
            type: 'object',
            properties: {
              core: {
                type: ['number', 'string'],
                enum: [0, 1],
                default: 0,
                description: 'Core index (0 or 1; accepts decimal or "0x...")',
              },
            },
          },
        },
        {
          name: 'run',
          description: TOOL_DESCRIPTIONS.run,
          inputSchema: {
            type: 'object',
            properties: {
              max_instructions: {
                type: ['number', 'string'],
                default: 10000,
                description: 'Instruction budget (decimal or "0x..." hex)',
              },
            },
          },
        },
        {
          name: 'set_breakpoint',
          description: TOOL_DESCRIPTIONS.set_breakpoint,
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: ['number', 'string'],
                description: 'Breakpoint address (decimal or "0x..." hex)',
              },
            },
            required: ['address'],
          },
        },
        {
          name: 'clear_breakpoint',
          description: TOOL_DESCRIPTIONS.clear_breakpoint,
          inputSchema: {
            type: 'object',
            properties: {
              address: {
                type: ['number', 'string'],
                description: 'Breakpoint address (decimal or "0x..." hex)',
              },
            },
            required: ['address'],
          },
        },
        {
          name: 'list_breakpoints',
          description: TOOL_DESCRIPTIONS.list_breakpoints,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'set_tracepoint',
          description: TOOL_DESCRIPTIONS.set_tracepoint,
          inputSchema: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'Unique name for this tracepoint' },
              address: {
                type: ['number', 'string'],
                description: 'Address of the jal instruction (decimal or "0x..." hex)',
              },
            },
            required: ['label', 'address'],
          },
        },
        {
          name: 'clear_tracepoint',
          description: TOOL_DESCRIPTIONS.clear_tracepoint,
          inputSchema: {
            type: 'object',
            properties: { label: { type: 'string' } },
            required: ['label'],
          },
        },
        {
          name: 'list_tracepoints',
          description: TOOL_DESCRIPTIONS.list_tracepoints,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'dump_pio',
          description: TOOL_DESCRIPTIONS.dump_pio,
          inputSchema: {
            type: 'object',
            properties: {
              instance: {
                type: ['number', 'string'],
                enum: [0, 1, 2],
                description: 'PIO instance index (accepts decimal or "0x...")',
              },
            },
          },
        },
        {
          name: 'dump_gpio',
          description: TOOL_DESCRIPTIONS.dump_gpio,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'load_firmware',
          description: TOOL_DESCRIPTIONS.load_firmware,
          inputSchema: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Path to the .hex or .uf2 file' },
              entry_pc: {
                type: ['number', 'string'],
                description: 'Optional entry PC (decimal or "0x..." hex; auto-detected if omitted)',
              },
              use_sram: {
                type: 'boolean',
                description: 'Force SRAM loading (auto-detected if omitted)',
              },
              disassembly_path: {
                type: 'string',
                description: 'Path to a .dis disassembly file for source context',
              },
              arch: {
                type: 'string',
                enum: ['riscv', 'arm'],
                description: "CPU architecture: 'riscv' (Hazard3, default) or 'arm' (Cortex-M33)",
              },
            },
            required: ['path'],
          },
        },
        {
          name: 'reset',
          description: TOOL_DESCRIPTIONS.reset,
          inputSchema: {
            type: 'object',
            properties: {
              keep_breakpoints: {
                type: 'boolean',
                description:
                  'If true, preserve breakpoints and tracepoints across the reset (default: false).',
              },
            },
          },
        },
        {
          name: 'convert_number',
          description: TOOL_DESCRIPTIONS.convert_number,
          inputSchema: {
            type: 'object',
            properties: {
              value: {
                type: 'string',
                description:
                  'Value to convert, e.g. "0x12345678" (hex→dec) or "305419896" (dec→hex)',
              },
            },
            required: ['value'],
          },
        },
        {
          name: 'dump_memory',
          description: TOOL_DESCRIPTIONS.dump_memory,
          inputSchema: {
            type: 'object',
            properties: {
              region: {
                type: 'string',
                enum: ['flash', 'sram'],
                description: 'Which memory region to dump',
              },
              address: {
                type: ['number', 'string'],
                description:
                  'Byte offset within the region (e.g. 0 for start of flash/SRAM; accepts decimal or "0x..." hex)',
              },
              length: {
                type: ['number', 'string'],
                description: 'Number of bytes to dump (decimal or "0x..." hex)',
              },
              format: {
                type: 'string',
                enum: ['ihex', 'text'],
                default: 'ihex',
                description: 'Output file format',
              },
            },
            required: ['region', 'address', 'length'],
          },
        },
      ],
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        return this.handleToolCall(name, args || {});
      } catch (e) {
        return {
          content: [{ type: 'text', text: `Error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    });

    return server;
  }
}
