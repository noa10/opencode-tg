// Smoke test: create a session, set agent/model, send a prompt, list messages,
// and verify the 404 shape used for session-recovery decisions.
import { makeClient } from "../src/opencode";
import { loadConfig } from "../src/config";

async function main() {
  const config = loadConfig();
  const client = makeClient({
    url: config.opencodeUrl,
    user: config.opencodeUser,
    password: config.opencodePassword,
  });

  const info = await client.GET("/api/info");
  console.log("info:", JSON.stringify(info.data));
  if (info.error) {
    console.error("info error:", info.error);
    process.exit(1);
  }

  const created = await client.POST("/api/session", {
    body: { title: "smoke-test", location: { directory: process.cwd() } } as any,
  });
  console.log("create:", JSON.stringify(created.data)?.slice(0, 200), created.error ?? "");
  if (!created.data) process.exit(1);
  const createdData = (created.data as any)?.data ?? created.data;
  const sessionID = createdData.id as string;

  // agent/model selection round-trip
  const agents = await client.GET("/api/agent", {
    params: { query: { location: { directory: process.cwd() } } },
  });
  const agentList = (agents.data as any)?.data ?? [];
  console.log("agents:", agentList.map((a: any) => a.id).join(", ") || "(none)");
  const agentSet = await client.POST("/api/session/{sessionID}/agent", {
    params: { path: { sessionID } },
    body: { agent: agentList[0]?.id } as any,
  });
  console.log("agent set:", agentSet.response.status, agentSet.error ?? "");

  const models = await client.GET("/api/model", {
    params: { query: { location: { directory: process.cwd() } } },
  });
  const modelList = ((models.data as any)?.data ?? []).filter((m: any) => m.enabled);
  console.log("models:", modelList.length);
  if (modelList[0]) {
    const modelSet = await client.POST("/api/session/{sessionID}/model", {
      params: { path: { sessionID } },
      body: { model: { id: modelList[0].id, providerID: modelList[0].providerID } } as any,
    });
    console.log("model set:", modelSet.response.status, modelSet.error ?? "");
  }

  // command endpoint if any commands exist
  const commands = await client.GET("/api/command", {
    params: { query: { location: { directory: process.cwd() } } },
  });
  const commandList = (commands.data as any)?.data ?? [];
  console.log("commands:", commandList.map((c: any) => c.name).slice(0, 5).join(", ") || "(none)");

  const prompt = await client.POST("/api/session/{sessionID}/prompt", {
    params: { path: { sessionID } },
    body: { text: "Reply with exactly: ok" } as any,
  });
  console.log("prompt status:", prompt.response.status, prompt.error ?? "");

  // poll messages; newest first
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const msgs = await client.GET("/api/session/{sessionID}/message", {
      params: { path: { sessionID } },
    });
    const list = (msgs.data as any)?.data ?? msgs.data ?? [];
    const assistant = list.find((m: any) => m.type === "assistant");
    const idle = list.find((m: any) => m.type === "idle");
    if (assistant && idle) {
      const text = assistant.content?.find((c: any) => c.type === "text")?.text ?? assistant.text;
      console.log("assistant text:", text, "| idle outcome:", idle.outcome);
      break;
    }
    if (i % 5 === 4) console.log("waiting for assistant message...");
  }

  // 404 shape check
  const bogus = await client.GET("/api/session/{sessionID}", {
    params: { path: { sessionID: "ses_doesnotexist000000000000" } },
  });
  console.log("bogus session GET -> status:", bogus.response.status, "error:", JSON.stringify(bogus.error));

  console.log("SMOKE OK, session", sessionID);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
