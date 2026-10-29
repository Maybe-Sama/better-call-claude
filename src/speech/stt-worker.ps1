param(
    [string]$Culture = 'es-ES',
    # Testing aid: recognise a WAV file instead of the default microphone, then exit.
    [string]$WavFile = ''
)

# Streaming Windows STT worker. Emits one JSON object per line on stdout:
#   {"type":"ready"} {"type":"partial","text":...} {"type":"final","text":...}
#   {"type":"level","value":0-100} {"type":"rejected"} {"type":"error","message":...}
# The engine raises its events on background threads; PowerShell script blocks cannot run there
# (no runspace), so the event wiring lives in a small C# class compiled at startup.
# All non-ASCII characters are emitted as \uXXXX escapes, so stdout encoding never corrupts accents.
# The worker exits when stdin is closed, so it never outlives AgentCall.

$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

public static class AgentCallStt
{
    static readonly object Gate = new object();
    static int lastLevelTick;
    static int peakLevel;

    public static string Esc(string s)
    {
        if (s == null) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            if (c == '"') sb.Append("\\\"");
            else if (c == '\\') sb.Append("\\\\");
            else if (c < 0x20 || c > 0x7e) sb.AppendFormat("\\u{0:x4}", (int)c);
            else sb.Append(c);
        }
        return sb.ToString();
    }

    public static void Emit(string json)
    {
        lock (Gate)
        {
            Console.Out.Write(json + "\n");
            Console.Out.Flush();
        }
    }

    static void EmitText(string type, RecognitionResult r)
    {
        if (r == null || string.IsNullOrEmpty(r.Text)) return;
        Emit("{\"type\":\"" + type + "\",\"text\":\"" + Esc(r.Text) + "\",\"confidence\":" +
             r.Confidence.ToString("0.###", CultureInfo.InvariantCulture) + ",\"peak\":" + peakLevel + "}");
    }

    public static int Run(string culture, string wavFile)
    {
        var info = new CultureInfo(culture);
        using (var engine = new SpeechRecognitionEngine(info))
        {
            engine.LoadGrammar(new DictationGrammar());
            bool fromFile = !string.IsNullOrEmpty(wavFile);
            if (fromFile) engine.SetInputToWaveFile(wavFile);
            else engine.SetInputToDefaultAudioDevice();

            var done = new ManualResetEvent(false);
            engine.SpeechHypothesized += (s, e) => EmitText("partial", e.Result);
            engine.SpeechDetected += (s, e) => { peakLevel = 0; };
            engine.SpeechRecognized += (s, e) => EmitText("final", e.Result);
            engine.SpeechRecognitionRejected += (s, e) => Emit("{\"type\":\"rejected\"}");
            engine.AudioLevelUpdated += (s, e) =>
            {
                if (e.AudioLevel > peakLevel) peakLevel = e.AudioLevel;
                int now = Environment.TickCount;
                if (now - lastLevelTick < 120) return;
                lastLevelTick = now;
                Emit("{\"type\":\"level\",\"value\":" + e.AudioLevel + "}");
            };
            engine.RecognizeCompleted += (s, e) =>
            {
                if (e.Error != null) Emit("{\"type\":\"error\",\"message\":\"" + Esc(e.Error.Message) + "\"}");
                done.Set();
            };

            Emit("{\"type\":\"ready\",\"culture\":\"" + Esc(info.Name) + "\",\"recognizer\":\"" + Esc(engine.RecognizerInfo.Description) + "\"}");

            if (fromFile)
            {
                engine.RecognizeAsync(RecognizeMode.Multiple);
                done.WaitOne(60000);
                return 0;
            }

            // Commands on stdin: "listen" / "pause". The engine stays loaded for the whole call so
            // resuming after Claude speaks is instant. EOF (parent gone) ends the worker.
            engine.RecognizeCompleted += (s, e) =>
            {
                lock (Gate) { running = false; }
                if (wantListening) Apply(engine);
                else Emit("{\"type\":\"paused\"}");
            };
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim().ToLowerInvariant();
                if (line == "listen") { wantListening = true; Apply(engine); }
                else if (line == "pause") { wantListening = false; Apply(engine); }
            }
            wantListening = false;
            Apply(engine);
            done.WaitOne(2000);
        }
        return 0;
    }

    static volatile bool wantListening;
    static bool running;

    static void Apply(SpeechRecognitionEngine engine)
    {
        lock (Gate)
        {
            if (wantListening && !running)
            {
                engine.RecognizeAsync(RecognizeMode.Multiple);
                running = true;
                Emit("{\"type\":\"listening\"}");
            }
            else if (!wantListening && running)
            {
                engine.RecognizeAsyncCancel();
            }
        }
    }
}
'@

try {
    Add-Type -AssemblyName System.Speech
    Add-Type -TypeDefinition $source -ReferencedAssemblies System.Speech
    exit [AgentCallStt]::Run($Culture, $WavFile)
}
catch {
    $text =$_.Exception.Message -replace '[^\x20-\x7e]', '?' -replace '\\', '\\' -replace '"', "'"
    [Console]::Out.Write('{"type":"error","message":"' + $text + '","hint":"Comprueba que Windows tenga instalado el reconocimiento de voz en es-ES. Puedes seguir usando el campo de texto."}' + "`n")
    [Console]::Out.Flush()
    exit 2
}
