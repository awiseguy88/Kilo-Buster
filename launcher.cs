using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
class KiloBuster {
  static void Main() {
    string root = AppDomain.CurrentDomain.BaseDirectory;
    string node = Path.Combine(root,"runtime","node.exe");
    string app = Path.Combine(root,"app");
    try {
      var keyStart = new ProcessStartInfo(node, "\"" + Path.Combine(app,"api-key.mjs") + "\"");
      keyStart.WorkingDirectory = app; keyStart.UseShellExecute = false; keyStart.RedirectStandardOutput = true; keyStart.CreateNoWindow = true;
      var keyProcess = Process.Start(keyStart); string token = keyProcess.StandardOutput.ReadToEnd().Trim(); keyProcess.WaitForExit();
      if (keyProcess.ExitCode != 0 || String.IsNullOrEmpty(token)) throw new Exception("Could not load the local API key.");
      string port = Environment.GetEnvironmentVariable("PORT"); if (String.IsNullOrEmpty(port)) port = "43817";
      var start = new ProcessStartInfo(node, "\"" + Path.Combine(app,"server.mjs") + "\"");
      start.WorkingDirectory = app; start.UseShellExecute = false; start.EnvironmentVariables["API_AUTH_TOKEN"] = token;
      var process = Process.Start(start); Thread.Sleep(1500); if (process.HasExited) { Console.WriteLine("Kilo Buster could not start. Check whether the port is already in use."); Console.ReadLine(); return; }
      Process.Start("http://127.0.0.1:" + port + "/dashboard?token=" + Uri.EscapeDataString(token));
      Console.WriteLine("Kilo Buster is running. Keep this window open; press Ctrl+C to stop."); Console.WriteLine("API key: " + token); Console.WriteLine("API base URL: http://127.0.0.1:" + port + "/v1"); process.WaitForExit();
    } catch (Exception e) { Console.WriteLine("Unable to start Kilo Buster: " + e.Message); Console.ReadLine(); }
  }
}
