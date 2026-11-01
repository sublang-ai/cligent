// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 SubLang International <https://sublang.ai>
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Diagnostics;
using System.Web.Script.Serialization;
class RecordingCodex {
    static int Main(string[] args) {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        var json = new JavaScriptSerializer();
        var prompt = Console.In.ReadToEnd();
        File.WriteAllText(Environment.GetEnvironmentVariable("CLIGENT_RECORD"), json.Serialize(new {
            pid = Process.GetCurrentProcess().Id, args, prompt,
            home = Environment.GetEnvironmentVariable("CODEX_HOME"),
            electron = Environment.GetEnvironmentVariable("ELECTRON_RUN_AS_NODE"),
            nodeOptions = Environment.GetEnvironmentVariable("NODE_OPTIONS"),
            path = Environment.GetEnvironmentVariable("PATH")
        }));
        var mode = Environment.GetEnvironmentVariable("CLIGENT_CASE");
        Console.WriteLine("{\"type\":\"thread.started\",\"thread_id\":\"windows-recording\"}");
        if (mode == "hang") { Thread.Sleep(Timeout.Infinite); }
        if (mode == "malformed") { Console.WriteLine("{broken"); return 0; }
        if (mode == "nonzero") { Console.Error.Write("native failure evidence"); return 7; }
        foreach (var text in new [] { "progress one", "progress two", "{\"ok\":true,\"text\":\"中文 space\"}" }) {
            Console.WriteLine(json.Serialize(new { type = "item.completed", item = new { id = "message", type = "agent_message", text } }));
        }
        Console.WriteLine("{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}");
        return 0;
    }
}
