$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Speech
    $recognizers = [System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()
    if (-not $recognizers -or $recognizers.Count -eq 0) {
        Write-Host "STT: no hay reconocedores System.Speech instalados." -ForegroundColor Red
    }
    else {
        Write-Host "STT disponibles:" -ForegroundColor Cyan
        foreach ($r in $recognizers) { Write-Host "  - $($r.Culture.Name) · $($r.Description)" }
        if (-not ($recognizers | Where-Object { $_.Culture.Name -eq 'es-ES' })) {
            Write-Host "AVISO: AgentCall V0 usa es-ES y no aparece instalado." -ForegroundColor DarkYellow
        }
    }

    $synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $voices = $synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo }
    Write-Host "TTS de Windows detectadas:" -ForegroundColor Cyan
    foreach ($v in $voices) { Write-Host "  - $($v.Name) · $($v.Culture.Name)" }
    $synth.Dispose()
}
catch {
    Write-Host "No se pudo consultar System.Speech: $($_.Exception.Message)" -ForegroundColor Red
    exit 2
}
