import { Server } from '@modelcontextprotocol/server';

// Legacy stdio is a persistent, bidirectional connection. Serving each message
// independently over legacy HTTP discards initialize-scoped capabilities and
// cannot return a human elicitation request to the original client.
export function legacyProxyFactory(endpoint, token) {
  let nextId = 0;
  return () => {
    const server = new Server({ name: 'agent-switchboard', version: '0.2.0' }, {
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true, subscribe: false }, prompts: {} },
      inputRequired: { maxRounds: 8, roundTimeoutMs: 300000 },
      instructions: 'Use native permissions, stable write identities and exact session IDs. Only the human answers elicitation requests. Provider-call receipts do not establish agent completion.',
    });
    const forward = async (request, ctx) => {
      const id = ++nextId;
      const capabilities = structuredClone(server.getClientCapabilities() ?? {});
      // The 2025 empty elicitation object means form support; URL support has
      // always required an explicit declaration. Do not add a missing ability.
      if (capabilities.elicitation && capabilities.elicitation.form === undefined && capabilities.elicitation.url === undefined)
        capabilities.elicitation.form = {};
      const params = { ...request.params,
        ...(ctx.mcpReq.inputResponses ? { inputResponses: ctx.mcpReq.inputResponses } : {}),
        ...(ctx.mcpReq.requestState() !== undefined ? { requestState: ctx.mcpReq.requestState() } : {}),
        _meta: { ...request.params?._meta,
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': server.getClientVersion() ?? { name: 'switchboard-stdio', version: '0.2.0' },
          'io.modelcontextprotocol/clientCapabilities': capabilities } };
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28', 'mcp-method': request.method };
      const name = params.name ?? params.uri;
      if (name) headers['mcp-name'] = name;
      const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method: request.method, params }),
        signal: AbortSignal.any([ctx.mcpReq.signal, AbortSignal.timeout(120000)]) });
      if (!response.ok) throw new Error(`Switchboard returned HTTP ${response.status}.`);
      let payload;
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        let buffer = ''; const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true });
          if (buffer.length > 4 * 1024 * 1024) throw new Error('MCP response exceeded the frame limit.');
          let boundary;
          while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
            const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
            const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
            if (data) { const item = JSON.parse(data); if (item.id === id) payload = item; }
          }
        }
      } else payload = await response.json();
      if (!payload || payload.error) throw new Error(payload?.error?.message ?? 'Missing MCP response.');
      return payload.result;
    };
    for (const method of ['tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'resources/read', 'prompts/list', 'prompts/get'])
      server.setRequestHandler(method, forward);
    return server;
  };
}
