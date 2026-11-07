using Fission.AI;
using Xunit;

namespace Fission.IntegrationTests;

/// <summary>AIGC 适配器纯函数面：请求形状 / 响应解析 / 提示模板 / 离线文案（不联网）。</summary>
public class AiProviderTests
{
    // ── DeepSeek ──

    [Fact]
    public void DeepSeek_ParseScripts_PlainJson()
    {
        var drafts = DeepSeekProvider.ParseScripts("""{"scripts":[{"title":"标题A","text":"正文一"},{"title":"标题B","text":"正文二"}]}""");
        Assert.Equal(2, drafts.Count);
        Assert.Equal("标题A", drafts[0].Title);
    }

    [Fact]
    public void DeepSeek_ParseScripts_StripsCodeFence()
    {
        var drafts = DeepSeekProvider.ParseScripts("```json\n{\"scripts\":[{\"title\":\"T\",\"text\":\"X\"}]}\n```");
        Assert.Single((System.Collections.ICollection)drafts);
    }

    [Fact]
    public void DeepSeek_ParseScripts_InvalidJson_ThrowsAiException()
    {
        Assert.Throws<AiException>(() => DeepSeekProvider.ParseScripts("这不是json"));
    }

    [Fact]
    public void DeepSeek_BuildPayload_ContainsAllInputs()
    {
        var payload = DeepSeekProvider.BuildPayload(("系统提示", "用户提示含 json 字样"), 5);
        dynamic o = payload;
        Assert.Equal("deepseek-flash", o["model"]);
        var messages = (object[])o["messages"];
        Assert.Equal(2, messages.Length);
        var user = (Dictionary<string, string>)messages[1];
        Assert.Contains("json", user["content"]);
        var fmt = (Dictionary<string, string>)o["response_format"];
        Assert.Equal("json_object", fmt["type"]);
        Assert.Equal(1.2, (double)o["temperature"], 2); // 0.7 + 5*0.1
    }

    // ── 提示模板 ──

    [Fact]
    public void PromptTemplates_CharBudget_FifteenPercentBand()
    {
        var (min, max) = PromptTemplates.CharBudget(12);
        Assert.Equal(45, min);  // 12*4.5=54 → 截断 *0.85
        Assert.Equal(62, max);  // 54*1.15
    }

    [Fact]
    public void PromptTemplates_Build_EmbedsProductAndScene()
    {
        var (sys, user) = PromptTemplates.Build(new ScriptRequest("小青柑", "果香浓\n回甘快", "筛果 → 洗果", "上班族", ScriptStyle.SalesPitch, 3, 12));
        Assert.Contains("带货", sys);
        Assert.Contains("小青柑", user);
        Assert.Contains("- 果香浓", user);
        Assert.Contains("筛果 → 洗果", user);
        Assert.Contains("json", user);
    }

    // ── 豆包 ──

    [Fact]
    public void Doubao_Parse_Base64Audio()
    {
        var bytes = new byte[] { 0x49, 0x44, 0x33, 0x04 }; // "ID3"
        var audio = DoubaoTtsProvider.Parse("""{"code":0,"message":"success","data":"SUQzBA=="}""", "zh_female_vv_uranus_bigtts");
        Assert.Equal(bytes, audio.Audio);
        Assert.Equal(".mp3", audio.Ext);
        Assert.Equal("doubao", audio.Provider);
    }

    [Fact]
    public void Doubao_Parse_NonZeroCode_ThrowsWithMessage()
    {
        var ex = Assert.Throws<AiException>(() => DoubaoTtsProvider.Parse("""{"code":45000001,"message":"invalid speaker"}""", "v"));
        Assert.Contains("45000001", ex.Message);
        Assert.Contains("invalid speaker", ex.Message);
    }

    [Fact]
    public void Doubao_BuildPayload_SpeakerAndRates()
    {
        var payload = DoubaoTtsProvider.BuildPayload(new TtsRequest("你好", "zh_female_vv_uranus_bigtts", Speed: 1.2, Volume: 1.0), "zh_female_vv_uranus_bigtts");
        dynamic o = payload;
        var req = (Dictionary<string, object>)o["req_params"];
        Assert.Equal("zh_female_vv_uranus_bigtts", req["speaker"]);
        var ap = (Dictionary<string, object>)req["audio_params"];
        Assert.Equal(1.2, (double)ap["speech_rate"], 2);
        Assert.Equal("mp3", ap["format"]);
    }

    // ── MiniMax ──

    [Fact]
    public void MiniMax_Parse_HexAudio()
    {
        var audio = MiniMaxTtsProvider.Parse("""{"data":{"audio":{"hex":"49443304"}},"base_resp":{"status_code":0}}""", "female-tianmei");
        Assert.Equal(new byte[] { 0x49, 0x44, 0x33, 0x04 }, audio.Audio);
        Assert.Equal("minimax", audio.Provider);
    }

    [Theory]
    [InlineData(1002, "AI_TTS_LIMIT")]
    [InlineData(1004, "AI_TTS_AUTH")]
    public void MiniMax_Parse_BaseRespCodes_Classified(int code, string expectCode)
    {
        var body = "{\"base_resp\":{\"status_code\":" + code + ",\"status_msg\":\"err\"},\"data\":{}}";
        var ex = Assert.Throws<AiException>(() => MiniMaxTtsProvider.Parse(body, "v"));
        Assert.Equal(expectCode, ex.Code);
    }

    // ── 离线兜底 ──

    [Fact]
    public async Task OfflineScript_NDrafts_AllDistinctWithBudget()
    {
        var llm = new OfflineScriptProvider();
        var drafts = await llm.GenerateAsync(new ScriptRequest("小青柑", "果香浓\n回甘快\n独立包装", string.Empty, "上班族", ScriptStyle.SalesPitch, 5, 12));
        Assert.Equal(5, drafts.Count);
        Assert.Equal(5, drafts.Select(d => d.Text).Distinct().Count()); // 卖点轮换+话术轮换 → 互异
        Assert.All(drafts, d => Assert.True(d.Text.Length >= 20, $"正文过短：{d.Text.Length}"));
    }

    [Fact]
    public void AiKeyStore_Mask_NeverLeaksFullKey()
    {
        Assert.Null(AiKeyStore.Mask(null));
        Assert.Equal("abcd******wxyz", AiKeyStore.Mask("abcdefghijklmwxyz"));
        Assert.Equal("********", AiKeyStore.Mask("12345678"));
    }

    // ── 文案模板（自由编辑）──

    [Fact]
    public void PromptTemplate_DefaultContainsAllPlaceholders()
    {
        var tpl = PromptTemplates.Default();
        foreach (var p in PromptTemplates.Placeholders.Where(p => p != "{{补充要求}}" && p != "{{风格提示}}"))
        {
            Assert.Contains(p, tpl.User);
        }

        Assert.Contains("{{风格提示}}", tpl.System);
        Assert.Contains("json", tpl.User); // response_format=json_object 需要提示出现 json 字样
    }

    [Fact]
    public void PromptTemplate_Render_SubstitutesFormFields()
    {
        var tpl = new PromptTemplate("人设：{{风格提示}}", "产品={{产品}} 条数={{条数}} 预算={{字数下限}}-{{字数上限}} 备注：{{补充要求}} 卖点：{{卖点}}");
        var (sys, user) = PromptTemplates.Render(new ScriptRequest("小青柑", "果香浓\n回甘快", string.Empty, "上班族", ScriptStyle.SalesPitch, 3, 10, ExtraNotes: "禁感叹号"), tpl);
        Assert.Contains("短视频带货口播文案作者", sys);
        Assert.Contains("产品=小青柑", user);
        Assert.Contains("条数=3", user);
        Assert.Contains("备注：禁感叹号", user);
        Assert.Contains("- 果香浓", user);
        Assert.DoesNotContain("{{", user); // 全部占位符被替换
    }

    [Fact]
    public void PromptTemplate_Render_EmptyNotesLeavesNoLeftover()
    {
        var (_, user) = PromptTemplates.Render(new ScriptRequest("P", "S", string.Empty, string.Empty, ScriptStyle.Seeding, 1, 10), PromptTemplates.Default());
        Assert.DoesNotContain("{{", user);
    }

    [Fact]
    public void PromptTemplateStore_SaveLoadReset()
    {
        var file = Path.Combine(Path.GetTempPath(), $"tpl-{Guid.NewGuid():N}.json");
        try
        {
            var store = new PromptTemplateStore(file);
            Assert.Contains("{{产品}}", store.Load().User); // 无文件=默认
            store.Save(new PromptTemplate("自定义系统", "自定义用户 {{产品}}"));
            var loaded = store.Load();
            Assert.Equal("自定义系统", loaded.System);
            Assert.Equal("自定义用户 {{产品}}", loaded.User);
            store.Reset();
            Assert.Contains("json", store.Load().User); // 重置回默认
        }
        finally
        {
            File.Delete(file);
        }
    }

    // ── 音色目录 ──

    [Fact]
    public void VoiceCatalog_Defaults_CoverBothProviders()
    {
        Assert.Contains(VoiceCatalog.Defaults, v => v.Provider == "doubao" && v.Id == "zh_female_vv_uranus_bigtts");
        Assert.Contains(VoiceCatalog.Defaults, v => v.Provider == "minimax" && v.Id == "female-tianmei");
        Assert.All(VoiceCatalog.Defaults, v => Assert.False(string.IsNullOrWhiteSpace(v.Label)));
    }

    [Fact]
    public void VoiceCatalog_FileOverridesDefaults()
    {
        var file = Path.Combine(Path.GetTempPath(), $"vc-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(file, "[{\"provider\":\"doubao\",\"id\":\"zh_test_x\",\"label\":\"测试音色\",\"tags\":\"测试\"}]");
            var list = VoiceCatalog.Load(file);
            Assert.Single((System.Collections.ICollection)list);
            Assert.Equal("测试音色", list[0].Label);
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public void AiKeyStore_RoundTrip()
    {
        var file = Path.Combine(Path.GetTempPath(), $"ai-keys-{Guid.NewGuid():N}.json");
        try
        {
            var store = new AiKeyStore(file);
            store.Save("deepseek", "sk-test-123456");
            store.Save("minimax", "mm-key");
            var k = store.Load();
            Assert.Equal("sk-test-123456", k.DeepSeek);
            Assert.Equal("mm-key", k.MiniMax);
            Assert.Equal(AiKeyStore.DoubaoResourceId, k.DoubaoResourceId); // 未写槽位=默认资源 ID
            store.Save("deepseek", null); // 清除
            Assert.Null(store.Load().DeepSeek);
        }
        finally
        {
            File.Delete(file);
        }
    }
}
