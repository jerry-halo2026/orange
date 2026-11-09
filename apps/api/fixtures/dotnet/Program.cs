using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Fission.Core.Jobs;
using Fission.Core.Materials;

// BCL fixture/decoder only. This does not prepare or execute a worker job.
if(args.Length!=1||!Path.IsPathFullyQualified(args[0]))throw new InvalidDataException("Explicit fixture required.");
using var document=JsonDocument.Parse(File.ReadAllBytes(args[0]));
var root=document.RootElement;
Exact(root,["version","projectId","filmRev","job","durationSec","aspect","fps","materials","scenes","audio","captions","transition"]);
if(Int(root.GetProperty("version"))!=1)throw new InvalidDataException("Unknown version.");
var native=JsonSerializer.Deserialize<FissionJob>(root.GetProperty("job"),new JsonSerializerOptions{PropertyNameCaseInsensitive=false,UnmappedMemberHandling=JsonUnmappedMemberHandling.Disallow})??throw new InvalidDataException("Missing native job.");
var serialized=JsonSerializer.SerializeToElement(native);
if(!serialized.TryGetProperty("VideoDir",out var originalPath)||originalPath.GetString()!=native.VideoDir||serialized.TryGetProperty("videoDir",out _)||native.OutFps!=Int(root.GetProperty("fps")))throw new InvalidDataException("Native serde mismatch.");
var image=new MaterialItem("C:/synthetic/fixture.png","1开场",0,true);
if(!image.IsImage||image.DurationSec!=0)throw new InvalidDataException("Native still contract mismatch.");
var parts=Parts(root);
using var canonical= new MemoryStream();
Encode(JsonSerializer.SerializeToElement(parts),canonical);
var key=Convert.ToHexStringLower(SHA256.HashData(canonical.ToArray()));
Console.WriteLine(JsonSerializer.Serialize(new{contentKey=key,nativeAssembly=typeof(FissionJob).Assembly.GetName().Name,nativeSerdePascalCase=true,nativeStillIntrinsicZero=true,fixtureOnly=true}));

static void Exact(JsonElement value,string[] fields){if(value.ValueKind!=JsonValueKind.Object||value.EnumerateObject().Count()!=fields.Length||fields.Any(name=>!value.TryGetProperty(name,out _)))throw new InvalidDataException("Unexpected fields.");}
static int Int(JsonElement value){var n=value.GetDouble();if(!double.IsFinite(n)||n!=Math.Truncate(n)||n<0||n>16384)throw new InvalidDataException("Invalid integer.");return checked((int)n);}
static double Number(JsonElement value){var n=value.GetDouble();if(!double.IsFinite(n)||n<0||n>1e12)throw new InvalidDataException("Invalid seconds.");return n==0?0:n;}
static string Text(JsonElement value)=>value.GetString()??throw new InvalidDataException("Expected text.");
static object?[] Parts(JsonElement p){
 var materials=p.GetProperty("materials").EnumerateArray().ToDictionary(m=>Guid.ParseExact(Text(m.GetProperty("versionId")),"D"));
 var used=new HashSet<Guid>();
 JsonElement Material(JsonElement id){var key=Guid.ParseExact(Text(id),"D");used.Add(key);return materials[key];}
 int w=Int(p.GetProperty("aspect")[0]),h=Int(p.GetProperty("aspect")[1]);if(w<=0||h<=0)throw new InvalidDataException("Invalid aspect.");
 int Gcd(int a,int b)=>b==0?a:Gcd(b,a%b);var d=Gcd(w,h);w/=d;h/=d;
 var duration=Number(p.GetProperty("durationSec"));if(duration<=0)throw new InvalidDataException("Invalid duration.");
 var visuals=new List<object?[]>();var ordinal=-1;double end=0;
 foreach(var scene in p.GetProperty("scenes").EnumerateArray()){
  Exact(scene,["ordinal","name","clips"]);var next=Int(scene.GetProperty("ordinal"));if(next<=ordinal)throw new InvalidDataException("Unordered scenes.");ordinal=next;
  foreach(var clip in scene.GetProperty("clips").EnumerateArray()){
   Exact(clip,["versionId","fromSec","toSec","atSec","speed","hflip","framing"]);var m=Material(clip.GetProperty("versionId"));var kind=Text(m.GetProperty("kind"));if(kind is not("video" or "still"))throw new InvalidDataException("Invalid visual.");
   double from=Number(clip.GetProperty("fromSec")),to=Number(clip.GetProperty("toSec")),at=Number(clip.GetProperty("atSec")),speed=Number(clip.GetProperty("speed")),intrinsic=Number(m.GetProperty("durationSec"));
   if(to<=from||speed<0.1||speed>100||at<end-1e-9||at+(to-from)/speed>duration+1e-9||(kind=="still"?(intrinsic!=0||from!=0):(intrinsic<=0||to>intrinsic)))throw new InvalidDataException("Invalid effective seconds.");end=at+(to-from)/speed;
   visuals.Add([Text(m.GetProperty("contentSha256")),kind,from,to,at,speed,clip.GetProperty("hflip").GetBoolean(),Text(clip.GetProperty("framing"))]);
  }
 }
 object? Track(JsonElement track,bool voice){if(track.ValueKind==JsonValueKind.Null){if(voice)throw new InvalidDataException("Missing voice.");return null;}Exact(track,["versionId","fromSec","toSec","volume","loop"]);var m=Material(track.GetProperty("versionId"));double from=Number(track.GetProperty("fromSec")),to=Number(track.GetProperty("toSec")),volume=Number(track.GetProperty("volume"));bool loop=track.GetProperty("loop").GetBoolean();if(Text(m.GetProperty("kind"))!="sound"||to<=from||to>Number(m.GetProperty("durationSec"))||volume>2||(voice&&loop))throw new InvalidDataException("Invalid audio.");return new object?[]{Text(m.GetProperty("contentSha256")),from,to,volume,loop};}
 var audio=p.GetProperty("audio");Exact(audio,["voice","music","postmix"]);var voice=Track(audio.GetProperty("voice"),true);var music=Track(audio.GetProperty("music"),false);var post=audio.GetProperty("postmix");Exact(post,["kind","integratedLUFS","truePeakDBTP","loudnessRangeLU"]);if(Text(post.GetProperty("kind"))!="loudnorm"||post.GetProperty("integratedLUFS").GetDouble()!=-14||post.GetProperty("truePeakDBTP").GetDouble()!=-1.5||post.GetProperty("loudnessRangeLU").GetDouble()!=11)throw new InvalidDataException("Invalid postmix.");
 object? captions=null,transition=null;
 if(p.GetProperty("captions").ValueKind!=JsonValueKind.Null){var c=p.GetProperty("captions");Exact(c,["style","cues"]);captions=new object?[]{Text(c.GetProperty("style")),c.GetProperty("cues").EnumerateArray().Select(q=>new object?[]{Number(q.GetProperty("fromSec")),Number(q.GetProperty("toSec")),Text(q.GetProperty("text"))}).ToArray()};}
 else if(p.GetProperty("job").TryGetProperty("SubtitleEnabled",out var enabled)&&enabled.GetBoolean())throw new InvalidDataException("Unprepared subtitle.");
 if(p.GetProperty("transition").ValueKind!=JsonValueKind.Null){var t=p.GetProperty("transition");Exact(t,["name","durationSec","shaderSha256"]);transition=new object?[]{Text(t.GetProperty("name")),Number(t.GetProperty("durationSec")),Text(t.GetProperty("shaderSha256"))};}
 else if(nativeTransition(p)>0)throw new InvalidDataException("Unprepared transition.");
 if(used.Count!=materials.Count||visuals.Count==0)throw new InvalidDataException("Dependency closure mismatch.");
 return ["orange-content",1,w,h,Int(p.GetProperty("fps")),duration,visuals,voice,music,new object?[]{"loudnorm",-14,-1.5,11},captions,transition];
}
static double nativeTransition(JsonElement p)=>p.GetProperty("job").TryGetProperty("TransitionSec",out var t)?t.GetDouble():0;
static void Encode(JsonElement value,Stream output){
 void Length(int n){Span<byte> bytes=stackalloc byte[4];BinaryPrimitives.WriteInt32BigEndian(bytes,n);output.Write(bytes);}
 switch(value.ValueKind){
 case JsonValueKind.Null:output.WriteByte(0);break;
 case JsonValueKind.False:output.WriteByte(1);break;
 case JsonValueKind.True:output.WriteByte(2);break;
 case JsonValueKind.Number:{var number=value.GetDouble();if(!double.IsFinite(number))throw new InvalidDataException("Nonfinite number.");output.WriteByte(3);Span<byte> bytes=stackalloc byte[8];BinaryPrimitives.WriteInt64BigEndian(bytes,BitConverter.DoubleToInt64Bits(number==0?0:number));output.Write(bytes);break;}
 case JsonValueKind.String:{var bytes=new UTF8Encoding(false,true).GetBytes(Text(value));output.WriteByte(4);Length(bytes.Length);output.Write(bytes);break;}
 case JsonValueKind.Array:output.WriteByte(5);Length(value.GetArrayLength());foreach(var element in value.EnumerateArray())Encode(element,output);break;
 case JsonValueKind.Object:{var properties=value.EnumerateObject().OrderBy(x=>x.Name,StringComparer.Ordinal).ToArray();if(properties.Any(x=>x.Name.Any(c=>c<' '||c>'~')))throw new InvalidDataException("Nonascii field.");output.WriteByte(6);Length(properties.Length);foreach(var property in properties){Encode(JsonSerializer.SerializeToElement(property.Name),output);Encode(property.Value,output);}break;}
 default:throw new InvalidDataException("Unsupported canonical value.");
 }
}