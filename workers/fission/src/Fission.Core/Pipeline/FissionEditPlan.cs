using System.Text.Json;

namespace Fission.Core.Pipeline;

/// <summary>Actual source/version in one immutable, non-authorizing edit receipt.</summary>
public sealed record FissionSource(string Path, string Sha256, string Kind, double DurationSec);
public sealed record FissionStage(int W, int H);
public sealed record VisualDecision(int Source, string Role, string Group, double StartSec, double DurationSec, double Speed, bool Hflip);
public sealed record AlignmentDecision(string Action, double InputDurationSec, double OutputDurationSec, double Tempo, int Loops);
public sealed record AudioTrackDecision(int Source, double Volume, bool Loop = false);
public sealed record LoudnormDecision(double IntegratedLUFS = -14, double TruePeakDBTP = -1.5, double LoudnessRangeLU = 11);
public sealed record AudioDecision(AudioTrackDecision Voice, AudioTrackDecision? Music, LoudnormDecision Loudnorm);
public sealed record ShaderDecision(string Path, string Sha256);
public sealed record TransitionDecision(string RequestedName, double DurationSec, string? SelectedName, ShaderDecision? Shader, string Outcome, double TailPaddingSec = 0.2);
public sealed record SubtitleCue(double StartSec, double EndSec, string Text);
public sealed record SubtitleStyleDecision(string Preset, string Position, int FontSize, string AssStyle, double FadeInSec = 0.12, double FadeOutSec = 0.12);
public sealed record SubtitleDecision(bool Requested, string Outcome, string TimingSource, IReadOnlyList<SubtitleCue> Cues, SubtitleStyleDecision? Style);

/// <summary>
/// Actual decisions of the original controlled Fission run. Not a shared-admission
/// FrozenPlan, authorization token, mutable timeline, or proof of media equivalence.
/// </summary>
public sealed record FissionEditPlan(int SchemaVersion, string JobId, int OutputIndex, FissionStage Stage, int Fps, double DurationSec,
    IReadOnlyList<FissionSource> Sources, IReadOnlyList<VisualDecision> Visuals, AlignmentDecision Alignment,
    AudioDecision Audio, TransitionDecision Transitions, SubtitleDecision Subtitles)
{
    private static readonly JsonSerializerOptions Options = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, WriteIndented = true };
    public bool ExportReady { get; }
    public bool EquivalenceVerified { get; }
    public IReadOnlyList<string> BlockingCapabilities
    {
        get
        {
            var values = new List<string> { "fission-postmix-loudnorm", "media-equivalence-unverified" };
            if (Transitions.Outcome == "applied") values.Add("fission-glsl-transition");
            if (Subtitles.Outcome == "applied") { values.Add("fission-ass-style"); values.Add("sentence-weighted-approximation"); }
            if (Visuals.Any(v => v.Hflip)) values.Add("fission-hflip-equivalence");
            return values.AsReadOnly();
        }
    }
    public string ToJson() => JsonSerializer.Serialize(this, Options);
}