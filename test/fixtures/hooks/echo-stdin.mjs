let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  const input = JSON.parse(raw);
  console.log(
    JSON.stringify({
      tool_name: input.tool_name,
      tool_use_id: input.tool_use_id,
      hook_event_name: input.hook_event_name,
      session_id: input.session_id,
      plugin_root: process.env.CLAUDE_PLUGIN_ROOT,
      project_dir: process.env.CLAUDE_PROJECT_DIR,
    }),
  );
});
