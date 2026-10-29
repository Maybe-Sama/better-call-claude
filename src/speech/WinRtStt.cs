// AgentCall speech worker based on the modern Windows recognizer (Windows.Media.SpeechRecognition,
// the engine behind Windows 11 dictation). Same line protocol as stt-worker.ps1:
//   stdout: {"type":"ready"|"listening"|"paused"|"partial"|"final"|"error", ...}  (ASCII, \uXXXX escapes)
//   stdin : "listen" | "pause"; EOF ends the worker.
// Compiled on demand by build-winrt-stt.ps1 with the C# compiler that ships with Windows (.NET Framework).
using System;
using System.Globalization;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Media.SpeechRecognition;

public static class AgentCallWinRtStt
{
    static readonly object Gate = new object();
    static SpeechRecognizer recognizer;
    static volatile bool wantListening;
    static bool running;
    static readonly SemaphoreSlim Busy = new SemaphoreSlim(1, 1);

    // Minimal awaiting of WinRT async operations without System.Runtime.WindowsRuntime's extensions
    // (those need the unified Windows.winmd, which Windows does not ship).
    static Task<T> Op<T>(IAsyncOperation<T> op)
    {
        var tcs = new TaskCompletionSource<T>();
        op.Completed = (o, status) =>
        {
            if (status == AsyncStatus.Completed) tcs.TrySetResult(o.GetResults());
            else if (status == AsyncStatus.Error) tcs.TrySetException(o.ErrorCode);
            else tcs.TrySetCanceled();
        };
        return tcs.Task;
    }

    static Task Act(IAsyncAction action)
    {
        var tcs = new TaskCompletionSource<bool>();
        action.Completed = (a, status) =>
        {
            if (status == AsyncStatus.Completed) { a.GetResults(); tcs.TrySetResult(true); }
            else if (status == AsyncStatus.Error) tcs.TrySetException(a.ErrorCode);
            else tcs.TrySetCanceled();
        };
        return tcs.Task;
    }

    static string Esc(string s)
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

    static void Emit(string json)
    {
        lock (Gate) { Console.Out.Write(json + "\n"); Console.Out.Flush(); }
    }

    static void EmitError(string message, string hint, bool fatal = true)
    {
        Emit("{\"type\":\"error\",\"engine\":\"winrt\",\"fatal\":" + (fatal ? "true" : "false") + ",\"message\":\"" + Esc(message) + "\",\"hint\":\"" + Esc(hint) + "\"}");
    }

    static double ConfidenceValue(SpeechRecognitionConfidence c)
    {
        switch (c)
        {
            case SpeechRecognitionConfidence.High: return 0.9;
            case SpeechRecognitionConfidence.Medium: return 0.7;
            case SpeechRecognitionConfidence.Low: return 0.4;
            default: return 0.1;
        }
    }

    public static int Main(string[] args)
    {
        string culture = args.Length > 0 ? args[0] : "es-ES";
        try
        {
            return Run(culture).GetAwaiter().GetResult();
        }
        catch (Exception ex)
        {
            EmitError(ex.Message, "Activa 'Reconocimiento de voz en linea' en Configuracion > Privacidad > Voz, o usa el campo de texto.");
            return 2;
        }
    }

    static async Task<int> Run(string culture)
    {
        recognizer = new SpeechRecognizer(new Language(culture));
        recognizer.Constraints.Add(new SpeechRecognitionTopicConstraint(SpeechRecognitionScenario.Dictation, "dictation"));
        // Generous silence handling: the app decides when an answer is finished.
        recognizer.ContinuousRecognitionSession.AutoStopSilenceTimeout = TimeSpan.FromHours(4);
        recognizer.Timeouts.EndSilenceTimeout = TimeSpan.FromMilliseconds(700);

        var compiled = await Op(recognizer.CompileConstraintsAsync());
        if (compiled.Status != SpeechRecognitionResultStatus.Success)
        {
            EmitError("No se pudo preparar el dictado de Windows: " + compiled.Status,
                "Activa 'Reconocimiento de voz en linea' en Configuracion > Privacidad y seguridad > Voz.");
            return 3;
        }

        recognizer.HypothesisGenerated += (s, e) =>
        {
            if (e.Hypothesis != null && !string.IsNullOrEmpty(e.Hypothesis.Text))
                Emit("{\"type\":\"partial\",\"text\":\"" + Esc(e.Hypothesis.Text) + "\"}");
        };
        recognizer.ContinuousRecognitionSession.ResultGenerated += (s, e) =>
        {
            var r = e.Result;
            if (r == null || string.IsNullOrEmpty(r.Text)) return;
            if (r.Status != SpeechRecognitionResultStatus.Success) return;
            Emit("{\"type\":\"final\",\"text\":\"" + Esc(r.Text) + "\",\"confidence\":" +
                 ConfidenceValue(r.Confidence).ToString("0.##", CultureInfo.InvariantCulture) + "}");
        };
        recognizer.ContinuousRecognitionSession.Completed += (s, e) =>
        {
            lock (Gate) { running = false; }
            if (e.Status != SpeechRecognitionResultStatus.Success && e.Status != SpeechRecognitionResultStatus.UserCanceled)
                EmitError("El dictado de Windows se ha detenido: " + e.Status, "Comprueba la conexion y el microfono, o usa el campo de texto.", false);
            if (wantListening) Task.Run(() => Apply());
            else Emit("{\"type\":\"paused\"}");
        };

        Emit("{\"type\":\"ready\",\"engine\":\"winrt\",\"culture\":\"" + Esc(culture) + "\",\"recognizer\":\"Windows dictation (" + Esc(culture) + ")\"}");

        string line;
        while ((line = Console.In.ReadLine()) != null)
        {
            line = line.Trim().ToLowerInvariant();
            if (line == "listen") { wantListening = true; await Apply(); }
            else if (line == "pause") { wantListening = false; await Apply(); }
        }
        wantListening = false;
        await Apply();
        return 0;
    }

    static async Task Apply()
    {
        await Busy.WaitAsync();
        try
        {
            bool isRunning;
            lock (Gate) { isRunning = running; }
            if (wantListening && !isRunning)
            {
                await Act(recognizer.ContinuousRecognitionSession.StartAsync());
                lock (Gate) { running = true; }
                Emit("{\"type\":\"listening\"}");
            }
            else if (!wantListening && isRunning)
            {
                await Act(recognizer.ContinuousRecognitionSession.CancelAsync());
                lock (Gate) { running = false; }
                Emit("{\"type\":\"paused\"}");
            }
        }
        catch (Exception ex)
        {
            lock (Gate) { running = false; }
            EmitError(ex.Message, "Activa 'Reconocimiento de voz en linea' en Configuracion > Privacidad y seguridad > Voz, o usa el campo de texto.");
        }
        finally
        {
            Busy.Release();
        }
    }
}
