/**
 * MCP server CLI runner for RP2350 RISC-V emulation.
 *
 * Starts with bootrom loaded but no firmware. Use the load_firmware MCP
 * tool to load a .hex file at runtime.
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

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RP2350McpServer } from '../src/mcp/rp2350-mcp-server';
import { bootrom_rp2350_A2 } from './bootrom_rp2350';

const mcpServer = new RP2350McpServer(bootrom_rp2350_A2);
const transport = new StdioServerTransport();

mcpServer
  .createServer()
  .connect(transport)
  .then(() => {
    console.error('RP2350 MCP server ready (no firmware loaded — use load_firmware tool)');
  });
