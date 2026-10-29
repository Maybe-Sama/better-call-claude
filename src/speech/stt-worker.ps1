$ErrorActionPreference = 'Stop'

function Emit-Json([hashtable]$Object) {
    $json = $Object | ConvertTo-Json -Compress -Depth 4
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

try {
    Add-Type -AssemblyName System.Speech
    $culture = [System.Globalization.CultureInfo]::GetCultureInfo('es-ES')
    $recognizer = New-Object System.Speech.Recognition.SpeechRecognitionEngine($culture)
    $grammar = New-Object System.Speech.Recognition.DictationGrammar
    $recognizer.LoadGrammar($grammar)
    $recognizer.SetInputToDefaultAudioDevice()

    $recognizer.add_SpeechHypothesized({
        param($sender, $eventArgs)
        if ($null -ne $eventArgs.Result -and $eventArgs.Result.Text) {
            Emit-Json @{ type = 'partial'; text = $eventArgs.Result.Text; confidence = $eventArgs.Result.Confidence }
        }
    })

    $recognizer.add_SpeechRecognized({
        param($sender, $eventArgs)
        if ($null -ne $eventArgs.Result -and $eventArgs.Result.Text) {
            Emit-Json @{ type = 'final'; text = $eventArgs.Result.Text; confidence = $eventArgs.Result.Confidence }
        }
    })

    $recognizer.add_SpeechRecognitionRejected({ Emit-Json @{ type = 'rejected' } })
    Emit-Json @{ type = 'ready'; culture = $culture.Name }
    $recognizer.RecognizeAsync([System.Speech.Recognition.RecognizeMode]::Multiple)
    while ($true) { Start-Sleep -Milliseconds 250 }
}
catch {
    Emit-Json @{ type = 'error'; message = $_.Exception.Message; hint = 'Comprueba que Windows tenga instalado el reconocimiento de voz en español. Puedes seguir usando el campo de texto.' }
    exit 2
}
finally {
    if ($null -ne $recognizer) {
        try { $recognizer.RecognizeAsyncCancel() } catch {}
        try { $recognizer.Dispose() } catch {}
    }
}
