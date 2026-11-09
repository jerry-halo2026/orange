using Fission.Core.Materials;
using Fission.Core.Pipeline;
using Fission.Core.Util;
using Xunit;

namespace Fission.UnitTests;

/// <summary>八策略对齐真值表（docs/contracts/align-strategies.json 同源断言，ADR-003）。</summary>
public class AlignPlannerTests
{
    [Theory]
    [InlineData(1, 40, 30, AlignAction.Trim, 30)]
    [InlineData(2, 20, 30, AlignAction.Trim, 20)] // L<R 裁掉=取可用长度
    [InlineData(2, 40, 30, AlignAction.Speed, 30, 4.0/3)]
    [InlineData(3, 20, 60, AlignAction.Trim, 20)]
    [InlineData(4, 40, 30, AlignAction.Speed, 30, 4.0 / 3)]
    [InlineData(6, 50, 25, AlignAction.Trim, 25)]
    [InlineData(6, 25, 50, AlignAction.Speed, 50, 0.5)]
    [InlineData(7, 25, 100, AlignAction.Loop, 100, 1, 4)]
    [InlineData(8, 100, 25, AlignAction.Speed, 25, 4.0)]
    [InlineData(8, 25, 75, AlignAction.Loop, 75, 1, 3)]
    public void Plan_StrategyTruthTable(int strategy, double l, double r, AlignAction action, double outDur, double tempo = 1, int loops = 1)
    {
        var plan = AlignPlanner.Plan(strategy, l, r);
        Assert.Equal(action, plan.Action);
        Assert.Equal(outDur, plan.OutDurationSec, 2);
        Assert.Equal(tempo, plan.Tempo, 2);
        Assert.Equal(loops, plan.Loops);
    }

    [Fact]
    public void AtempoChain_Over2Splits()
    {
        Assert.Equal("atempo=2.0,atempo=1.5", AlignPlanner.AtempoChain(3.0));
        Assert.Equal("atempo=2.0,atempo=2.0,atempo=1.25", AlignPlanner.AtempoChain(5.0));
    }

    [Fact]
    public void AtempoChain_UnderHalfDoublesUp()
    {
        Assert.Equal("atempo=0.5,atempo=0.5", AlignPlanner.AtempoChain(0.25));
    }

    [Fact]
    public void Plan_StrategyOutOfRangeThrows()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => AlignPlanner.Plan(9, 10, 10));
    }
}

/// <summary>素材池消耗事务（ADR-002）：预留独占/确认计次/回滚/组合去重/并发零重复。</summary>
public class MaterialPoolTests
{
    private static MaterialItem V(string path, double dur = 5, string group = "1组") => new(path, group, dur);
    private static MaterialItem A(string path, double dur = 10) => new(path, string.Empty, dur);

    [Fact]
    public void Reserve_ThenConfirm_AudioConsumedOnce()
    {
        var pool = new MaterialPool([A("a1.mp3"), V("v1.mov"), V("v2.mov")]);
        pool.SetAudioUses("a1.mp3", 1);
        var r = pool.Reserve(A("a1.mp3"), [V("v1.mov")]);
        pool.Confirm(r, "out1.mp4");
        Assert.False(pool.CheckAvailable("a1.mp3"));
        Assert.Throws<Fission.Core.Errors.MaterialException>(() => pool.Reserve(A("a1.mp3"), [V("v2.mov")]));
    }

    [Fact]
    public void Reserve_SameVideoCannotDoubleReserve()
    {
        var pool = new MaterialPool([V("v1.mov"), V("v2.mov")]);
        var r1 = pool.Reserve(null, [V("v1.mov")]);
        Assert.Throws<Fission.Core.Errors.MaterialException>(() => pool.Reserve(null, [V("v1.mov")]));
        pool.Release(r1);
        Assert.True(pool.CheckAvailable("v1.mov"));
    }

    [Fact]
    public void AudioUses_N_AllowsNConfirmations()
    {
        var pool = new MaterialPool([A("a1.mp3"), V("v1.mov"), V("v2.mov"), V("v3.mov")]);
        pool.SetAudioUses("a1.mp3", 3);
        for (var i = 0; i < 3; i++)
        {
            var v = $"v{i + 1}.mov";
            var r = pool.Reserve(A("a1.mp3"), [V(v)]);
            pool.Confirm(r, $"out{i}.mp4");
        }

        Assert.False(pool.CheckAvailable("a1.mp3")); // 第 3 次用尽
    }

    [Fact]
    public void Release_RollbackMakesAudioAvailableAgain()
    {
        var pool = new MaterialPool([A("a1.mp3"), V("v1.mov"), V("v2.mov")]);
        pool.SetAudioUses("a1.mp3", 1);
        var r = pool.Reserve(A("a1.mp3"), [V("v1.mov")]);
        pool.Release(r);
        Assert.True(pool.CheckAvailable("a1.mp3"));
        _ = pool.Reserve(A("a1.mp3"), [V("v2.mov")]); // 可再次预留
    }

    [Fact]
    public void CombinationDedup_SameAudioSameVideosRejected()
    {
        var pool = new MaterialPool([A("a1.mp3"), V("v1.mov"), V("v2.mov"), V("v3.mov")]);
        pool.SetAudioUses("a1.mp3", 0); // 不限
        var r1 = pool.Reserve(A("a1.mp3"), [V("v1.mov"), V("v2.mov")]);
        pool.Confirm(r1, "out1.mp4");
        Assert.Throws<Fission.Core.Errors.MaterialException>(() => pool.Reserve(A("a1.mp3"), [V("v1.mov"), V("v2.mov")]));
    }

    [Fact]
    public async Task Concurrent20Workers_ZeroDoubleReservation()
    {
        var audios = Enumerable.Range(0, 30).Select(i => A($"a{i:D2}.mp3")).ToList();
        var videos = Enumerable.Range(0, 100).Select(i => V($"v{i:D3}.mov")).ToList();
        var pool = new MaterialPool(audios.Concat(videos));
        foreach (var a in audios)
        {
            pool.SetAudioUses(a.Path, 1);
        }

        var results = new System.Collections.Concurrent.ConcurrentBag<(int Ok, int Dup)>();
        var cursor = -1;
        await Parallel.ForEachAsync(Enumerable.Range(0, 20), new ParallelOptions { MaxDegreeOfParallelism = 20 }, async (_, ct) =>
        {
            var ok = 0;
            var blocked = 0;
            var rng = new SeededRandom(Environment.TickCount);
            for (var attempt = 0; attempt < 40 && ok < 5; attempt++)
            {
                var audio = audios[Math.Abs(Interlocked.Increment(ref cursor)) % audios.Count];
                var picks = new List<MaterialItem>();
                var idx = rng.Next(videos.Count);
                for (var k = 0; k < 3; k++)
                {
                    picks.Add(videos[(idx + k) % videos.Count]);
                }

                try
                {
                    var r = pool.Reserve(audio, picks);
                    pool.Confirm(r, "out.mp4");
                    ok++;
                }
                catch (Fission.Core.Errors.MaterialException)
                {
                    blocked++;
                }

                await Task.Yield();
            }

            results.Add((ok, blocked));
        });

        // 并发下零双确认：每个音频最多 1 次成功
        var log = pool.Log.Where(l => l.ConfirmedAt is not null).GroupBy(l => l.Audio);
        Assert.All(log, g => Assert.True(g.Count() <= 1, $"音频 {g.Key} 被确认 {g.Count()} 次"));
        Assert.True(results.Sum(r => r.Ok) > 0, "并发预留应至少有成功样本");
    }
}

/// <summary>分割规划数学（PRD FR-3.4）。</summary>
public class SplitPlannerTests
{
    [Fact]
    public void AveragePieces_SumsToDuration()
    {
        var cuts = SplitPlanner.AveragePieces(10, 4);
        Assert.Equal(4, cuts.Count);
        Assert.Equal(10, cuts.Sum(c => c.DurationSec), 6);
    }

    [Fact]
    public void BySeconds_TailShorter()
    {
        var cuts = SplitPlanner.BySeconds(7, 3);
        Assert.Equal([3, 3, 1], cuts.Select(c => c.DurationSec).ToArray());
    }

    [Fact]
    public void RandomRange_FixedWhenEqual()
    {
        var cuts = SplitPlanner.RandomRange(10, 2, 2, new SeededRandom(1));
        Assert.All(cuts, c => Assert.Equal(2, c.DurationSec, 6));
    }

    [Fact]
    public void ApplyMinMax_MergesShortIntoNext_TailIntoPrev()
    {
        var cuts = new List<CutSpan> { new(0, 0.5), new(0.5, 3), new(3.5, 3), new(6.5, 0.4) };
        var merged = SplitPlanner.ApplyMinMax(cuts, minSec: 1, maxSec: 0);
        Assert.Equal(2, merged.Count);
        Assert.Equal(3.5, merged[0].DurationSec, 6); // 0.5 并入下一
        Assert.Equal(3.4, merged[^1].DurationSec, 6); // 尾 0.4 并入前
    }
}

/// <summary>场景组网格列语义（原版列：顺序或随机/每次抽取几个/视频变速/用过是否删除/重复抽取；dump 0x014ff945–0x014ff975）。</summary>
public class SceneGroupSemanticsTests
{
    private static MaterialItem V(string path, double dur = 5, string group = "1组") => new(path, group, dur);

    [Fact]
    public void Reserve_ReusableVideo_DuplicateInOneReservationAllowed()
    {
        var pool = new MaterialPool([V("v1.mov"), V("v2.mov")]);
        var reusable = new HashSet<string> { "v1.mov" };
        var r = pool.Reserve(null, [V("v1.mov"), V("v1.mov")], 1, reusable); // 重复抽取=是
        pool.Confirm(r, "out.mp4");
        Assert.True(pool.CheckAvailable("v1.mov")); // 未开删除 → 耐用品
    }

    [Fact]
    public void Reserve_ReusableVideo_ConsumedStillDrawable()
    {
        var pool = new MaterialPool([V("v1.mov"), V("v2.mov")]);
        var reusable = new HashSet<string> { "v1.mov" };
        var r1 = pool.Reserve(null, [V("v1.mov")], 1, reusable);
        pool.Confirm(r1, "out1.mp4", ["v1.mov"]); // 用过是否删除=是
        Assert.False(pool.CheckAvailable("v1.mov"));
        Assert.True(pool.CheckAvailable("v1.mov", reusable)); // 重复抽取优先级更高
        var r2 = pool.Reserve(null, [V("v1.mov"), V("v2.mov")], 1, reusable); // 已消耗仍可再抽
        pool.Confirm(r2, "out2.mp4");
    }

    [Fact]
    public void Confirm_ConsumeVideos_MarksConsumedAndWritesCrossBatchCache()
    {
        var cache = Path.Combine(Path.GetTempPath(), $"fission-cache-{Guid.NewGuid():N}.ini");
        try
        {
            var pool = new MaterialPool([V("v1.mov"), V("v2.mov")], cache);
            var r = pool.Reserve(null, [V("v1.mov"), V("v2.mov")]);
            pool.Confirm(r, "out.mp4", ["v1.mov"]); // 仅 v1 组开了「用过是否删除」
            Assert.False(pool.CheckAvailable("v1.mov"));
            Assert.True(pool.CheckAvailable("v2.mov"));
            Assert.Contains("v1.mov", File.ReadAllText(cache));

            // 跨批次：新池读缓存即排除已用
            var pool2 = new MaterialPool([V("v1.mov"), V("v2.mov")], cache);
            Assert.False(pool2.CheckAvailable("v1.mov"));
            Assert.True(pool2.CheckAvailable("v2.mov"));
        }
        finally
        {
            File.Delete(cache);
        }
    }

    [Fact]
    public void Validate_GroupSpeedBelowHalf_Throws()
    {
        var dir = System.IO.Directory.CreateTempSubdirectory();
        try
        {
            var job = new Fission.Core.Jobs.FissionJob
            {
                VideoDir = dir.FullName,
                GeneratedAudioCount = 1,
                SceneGroups = [new Fission.Core.Jobs.SceneGroupConfig("1筛果", Speed: 0.4)],
            };
            Assert.Throws<Fission.Core.Errors.ConfigException>(job.Validate);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void Validate_GroupSpeedHalf_Passes()
    {
        var dir = System.IO.Directory.CreateTempSubdirectory();
        try
        {
            var job = new Fission.Core.Jobs.FissionJob
            {
                VideoDir = dir.FullName,
                GeneratedAudioCount = 1,
                SceneGroups =
                [
                    new Fission.Core.Jobs.SceneGroupConfig("1筛果", Speed: 0.5, Rule: Fission.Core.Jobs.GroupRule.Sequential, UseThenDelete: true),
                    new Fission.Core.Jobs.SceneGroupConfig("2洗果", TakePerOutput: 2, AllowReuse: true),
                ],
            };
            job.Validate(); // 0.5=下限，通过
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }

    [Fact]
    public void Validate_ImageDurNonPositive_Throws()
    {
        var dir = System.IO.Directory.CreateTempSubdirectory();
        try
        {
            var job = new Fission.Core.Jobs.FissionJob { VideoDir = dir.FullName, GeneratedAudioCount = 1, ImageDurMinSec = 0 };
            Assert.Throws<Fission.Core.Errors.ConfigException>(job.Validate);
        }
        finally
        {
            dir.Delete(recursive: true);
        }
    }
}

/// <summary>口播文案 → ASS 字幕规划（句级均分时间轴 + 四样式预设 × 三位置）。</summary>
public class SubtitlePlannerTests
{
    [Fact]
    public void BuildAss_EventsProportionalToSentenceLength()
    {
        var ass = SubtitlePlanner.BuildAss("第一句话。第二句比较长一些哦！短。", 10, "white-outline", "bottom", 64);
        Assert.Contains("[Script Info]", ass);
        Assert.Contains("Style: Default,Microsoft YaHei,64", ass);
        Assert.Equal(3, ass.Split("Dialogue:", StringSplitOptions.RemoveEmptyEntries).Length - 1); // 3 句 3 事件
        Assert.Contains("0:00:10.00", ass); // 末句铺满总时长
        Assert.Contains("\\fad(120,120)", ass);
    }

    [Theory]
    [InlineData("white-outline", ",1,3,1,2,40,40,140,1")]  // BorderStyle,Outline,Shadow,Alignment,ML,MR,MV,Encoding
    [InlineData("white-box", ",3,2,1,2,40,40,140,1")]
    public void BuildAss_StylePresets(string style, string expectTail)
    {
        var ass = SubtitlePlanner.BuildAss("一。", 5, style, "bottom", 64);
        Assert.Contains("Style: Default,Microsoft YaHei,64,&H00FFFFFF" + ",&H000000FF,&H00000000,&H66000000,0,0,0,0,100,100,0,0" + expectTail, ass);
    }

    [Theory]
    [InlineData("top", ",8,40,40,120,")]
    [InlineData("middle", ",5,40,40,0,")]
    [InlineData("bottom", ",2,40,40,140,")]
    public void BuildAss_PositionAlignments(string pos, string expect)
    {
        var ass = SubtitlePlanner.BuildAss("一。", 5, "white-outline", pos, 64);
        Assert.Contains(expect, ass);
    }

    [Fact]
    public void Split_KeepsPunctuationAndDropsEmpty()
    {
        var parts = SubtitlePlanner.Split("你好。世界！\n继续？");
        Assert.Equal(["你好。", "世界！", "继续？"], parts);
    }
}

/// <summary>命名 sanitize（PRD FR-8.5）。</summary>
public class SanitizeTests
{
    [Theory]
    [InlineData("a/b\\c:d*e?f\"g<h>i|j", "a_b_c_d_e_f_g_h_i_j")]
    [InlineData("   ", "未命名")]
    [InlineData("正常标题", "正常标题")]
    public void Sanitize_IllegalCharsReplaced(string input, string expect)
    {
        Assert.Equal(expect, FileNameSanitizer.Sanitize(input));
    }

    [Fact]
    public void Sanitize_TruncatesTo80()
    {
        Assert.Equal(80, FileNameSanitizer.Sanitize(new string('长', 200)).Length);
    }
}


/// <summary>The same real sentence timing must feed ASS and the handoff record.</summary>
public class HandoffSubtitleCueTests
{
    [Fact]
    public void BuildCues_PreservesOriginalWeightedTimesUsedByAss()
    {
        var cues = SubtitlePlanner.BuildCues("甲。乙乙。", 5);
        Assert.Equal(2, cues.Count);
        Assert.Equal(0, cues[0].StartSec); Assert.Equal(2, cues[0].EndSec);
        Assert.Equal(2, cues[1].StartSec); Assert.Equal(5, cues[1].EndSec);
        var ass = SubtitlePlanner.BuildAss("甲。乙乙。", 5, "white-outline", "bottom", 64);
        Assert.Contains("Dialogue: 0,0:00:00.00,0:00:02.00", ass);
        Assert.Contains("Dialogue: 0,0:00:02.00,0:00:05.00", ass);
    }
}