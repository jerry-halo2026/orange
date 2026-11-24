// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

// @ts-check
/**
 * Our Studio words, apart from upstream's tables: the phrases we wrote, in the languages we wrote them in.
 *
 * Why one file: our edits to upstream's locale tables lived inside a 140k-line diff, one scattered change at a time.
 * Keeping ours here gives our copy one owner and one diff, and lets the overlay step take these keys out of the
 * upstream files without losing the words.
 *
 * Only the keys we changed or added are here (138 in English); every other path is upstream's and stays
 * there. Keys we retired on purpose, which must not come back:
 * whatsNew.changelog, projects.getFromGitHub, projects.fetch.title, projects.fetch.urlLabel, projects.fetch.placeholder, projects.fetch.hint, projects.fetch.get, settings.links.github, settings.links.examples, settings.links.site, settings.providers.addHow
 */
import type { Words } from './words.ts';

/** The languages Studio shows, in the order its tables are laid out. */
export type OrangeLanguage = 'en' | 'zh-CN' | 'ja' | 'ko' | 'es';

/** 138 paths: our English, typed against the table it overlays so a path upstream has no key for is caught here. */
const en: Words = {
  workspace: {
    fissionPurpose: 'Create batches independently. Keep videos first; make editable drafts only for selected results.',
    sourceSelection: 'Choose materials',
    sourceHint: 'Choose permitted cloud or local materials in the same center. Confirm rights and source retrieval before starting.',
    openMaterials: 'Open Material Center',
    batchTasks: 'Batch tasks',
    batchPending: 'Independent batch execution and recovery are still being connected. No task starts here yet.',
    voiceScript: 'Script and voice',
    modelPending: 'Model services are unverified. Enable them only after cost and input boundaries are confirmed.',
    outputSettings: 'Output settings',
    outputPending: 'Resolution, count, transitions, captions and audio will use the existing Fission capabilities.',
    results: 'Videos and drafts',
    resultHint: 'Videos can be delivered directly. Open only selected results as editable Studio drafts.',
    materialPurpose: 'Browse permitted cloud materials and your local personal materials in one place.',
    cloud: 'Cloud materials',
    local: 'Local materials',
    filters: 'Material filters',
    mainCategory: 'Main category',
    category: 'Category',
    subCategory: 'Subcategory',
    tags: 'Public tags',
    author: 'Author',
    filterUnconfirmed: 'Category data awaits verified Zhishang API and permission details',
    localFilter: 'Browse local materials in projects owned by this account',
    cloudUnavailable: 'The cloud catalog cannot be confirmed now. Local materials remain available.',
    metadataOnly: 'Confirmed directory metadata only; this does not grant original source retrieval.',
    previewVideo: 'Preview local video. Focus or hover to play; leave or blur to stop. Space toggles and Escape stops.',
    previewUnavailable: 'Preview unavailable',
    thumbnailUnavailable: 'Thumbnail unavailable',
    durationUnconfirmed: 'Duration unavailable until its unit is verified',
    localEmpty: 'No matching local materials in the selected project.',
    localProject: 'Source project',
    chooseProject: 'Choose project',
    backToPanel: 'Back to project media',
    openFission: 'Review batch selection',
    importLocal: 'Import local files',
    selectForBatch: 'Select for review',
    selectedForBatch: 'Selected for review',
    insertInStudio: 'Add to timeline',
    unverifiedSelection: 'Rights and version unconfirmed',
    materialRole: 'Use',
    role_video: 'Scene',
    role_voice: 'Voice',
    role_bgm: 'Background music',
    role_intro: 'Intro',
    role_outro: 'Outro',
    sceneGroup: 'Scene group',
    removeSelection: 'Remove',
    startBatch: 'Start batch',
    draftUnavailable: 'Cross-page selection is unavailable until sign-in and the workspace are ready.',
    draftConflict: 'Another page updated the selection. Review it and try again.',
    draftRetry: 'Reconnect',
    invalidGroup: 'Enter a valid scene group name.',
    localUnavailable: 'Local project materials are unavailable.',
  },
  homeCards: {
    home: 'Home',
    settings: 'Settings',
    features: 'Create with orangeflim',
    title: 'Start your next project',
    fission: 'Super Mixing',
    studio: 'Creation Center',
    catalog: 'Material Center',
    fissionBody: 'Choose local folders and create batches by scene.',
    studioBody: 'Continue editing and exporting in the original Studio.',
    catalogBody: 'Browse local materials; cloud materials are being connected.',
    choose: 'Open or create a project below for the Creation Center.',
    studioGuide: 'The selected project opens in the original Studio.',
    resume: 'Return to current project',
    recent: 'Recent projects',
    all: 'All projects',
    myProjects: 'My projects',
    loading: 'Reading your projects…',
    empty: 'No projects in this account yet. Create or open one below.',
  },
  homeEntry: {
    projects: 'Projects',
    fission: 'Super Mixing',
    catalog: 'Material Center',
    chooseProject: 'Choose an original project below first.',
    nextFission: 'Then use Super Mixing in the project toolbar.',
    nextCatalog: 'Then use Material Center in the project toolbar. This does not open a tool automatically in another tab.',
  },
  catalog: {
    title: 'Zhishang materials',
    local: 'Local materials',
    readOnly: 'Read-only catalog for your verified cloud account. No original/thumbnail download, upload, registration or editing permission is implied.',
    search: 'Search',
    refresh: 'Refresh',
    loading: 'Reading the catalog…',
    page: 'Page',
    noGrant: 'Metadata only · grants: false',
    empty: 'This authorized query returned no items.',
    previous: 'Previous',
    next: 'Next',
    binding: 'Your cloud account binding has not been verified. Local materials and Fission remain available.',
    bindingChanged: 'The cloud account binding changed. Query again under the current account.',
    config: 'The business service or Zhishang backend credentials are not configured. Local materials remain available.',
    denied: 'The cloud service denied this account access.',
    auth: 'Sign in again to read the catalog.',
    unknown: 'The catalog could not be confirmed. This is not an empty result; retry when the service is available.',
  },
  fissionBatch: {
    import: 'Open editable source draft',
    importFailed: 'The source draft could not be safely imported.',
    title: 'Fission → Studio batch',
    group: 'Business group UUID (membership checked by the service)',
    ready: 'Batch submission is connected. The service checks current membership, material permissions and runtime.',
    unavailable: 'Batch service is not configured. Local editing and import remain available.',
    candidate: 'Rendered-unverified outputs are candidates, not delivered or imported projects. Editable source handoff is still required.',
    retirementPending: 'Cancellation must be confirmed by actual resource-drain evidence. An unknown response never releases claims or permits account switching.',
    VideoDir: 'Project video directory',
    AudioDir: 'Project voice directory',
    BgmDir: 'Music directory (optional)',
    IntroDir: 'Intro directory (optional)',
    OutroDir: 'Outro directory (optional)',
    Count: 'Output count (0 = native automatic count)',
    Threads: 'Worker concurrency',
    phase: 'Actual phase',
    close: 'Hide window (does not stop task)',
    cancel: 'Request cancellation and check state',
    new: 'Explicit new batch',
    start: 'Submit batch',
    retry: 'Retry the same request',
    submitting: 'Submitting…',
    unconfirmed: 'Batch state could not be confirmed.',
  },
  material: {
    register: 'Register with business service (upload)',
    registering: 'Registering this file…',
    registered: 'File registered. Current permission is checked when it is used.',
    unknown: 'Registration is unconfirmed. The original file is kept; retry uses the same request.',
    unavailable: 'Business service is not configured. Local import and editing are unchanged.',
    stale: 'The source changed. Its old registration cannot authorize this file.',
    unregistered: 'This file has not been registered.',
  },
  gallery: {
    skillsIndex: 'Skills index',
    empty: 'No examples to show. They are read from the skills index: check the connection.',
    viewSource: 'View source',
  },
  settings: {
    servicesLoading: 'Loading service settings…',
    servicesUnavailable: 'Service settings are temporarily unavailable.',
    servicesRetry: 'Retry',
    servicesLimited: 'This isolated environment supports local configuration only; media generation, online authorization and model installation are not enabled yet.',
  },
  materialCenter: {
    cloudSteward: 'Cloud steward material',
    closePanel: 'Collapse',
  },
  projects: {
    fetch: {
      error: {
        host: 'Studio reads its examples from its skills index, over https only.',
        network: 'Couldn’t reach the index. Check your internet connection.',
        git: 'This one needs git: it is private, or kept outside the index. Install git, then try again.',
      },
    },
  },
  assetDrawer: {
    mineEmpty: 'Import one from the skills index or a folder on this computer; every project can use it.',
    mineEmptyCli: 'Run orangefilm skill add with a skill from the skills index, or a folder; every project can use it.',
  },
};

/** 138 paths, the same ones. */
const zhCN: Words = {
  workspace: {
    fissionPurpose: '独立批量创作：先生成和管理成片，仅为选中的结果建立可编辑草稿。',
    sourceSelection: '素材选择',
    sourceHint: '从同一素材中心选择有权云端或本地素材；原片领取和使用权须在启动前确认。',
    openMaterials: '打开素材中心',
    batchTasks: '批次任务',
    batchPending: '独立批次执行与恢复尚在接线，当前不启动任务。',
    voiceScript: '文案与配音',
    modelPending: '模型服务未实测，费用和输入范围确认后开放。',
    outputSettings: '输出设置',
    outputPending: '分辨率、数量、转场、字幕及音轨将沿原 Fission 能力接入。',
    results: '成片与草稿',
    resultHint: '成片可独立交付；仅对选中的结果执行“进入创作中心”。',
    materialPurpose: '同一入口浏览云端授权素材与本地个人素材。',
    cloud: '云端素材',
    local: '本地素材',
    filters: '素材筛选',
    mainCategory: '主类目',
    category: '一级分类',
    subCategory: '二级分类',
    tags: '公共标签',
    author: '作者',
    filterUnconfirmed: '分类数据待智尚接口和权限核实',
    localFilter: '查看当前账号有权工程中的本地素材',
    cloudUnavailable: '云端目录目前不可确认；本地素材仍可使用。',
    metadataOnly: '仅展示已确认的目录元数据，尚不代表可领取原片。',
    previewVideo: '预览本地视频，聚焦或悬停播放，移开或失焦停止；空格切换，Esc 停止',
    previewUnavailable: '预览暂不可用',
    thumbnailUnavailable: '缩略图暂不可用',
    durationUnconfirmed: '时长单位待确认',
    localEmpty: '所选工程中没有匹配的本地素材。',
    localProject: '来源工程',
    chooseProject: '选择工程',
    backToPanel: '返回素材面板',
    openFission: '查看混剪待选',
    importLocal: '导入本地文件',
    selectForBatch: '加入待选（待核权）',
    selectedForBatch: '已加入待选',
    insertInStudio: '加入时间线',
    unverifiedSelection: '待核权和版本确认',
    materialRole: '用途',
    role_video: '场景画面',
    role_voice: '配音',
    role_bgm: '背景音乐',
    role_intro: '片头',
    role_outro: '片尾',
    sceneGroup: '场景组',
    removeSelection: '移除',
    startBatch: '开始批量混剪',
    draftUnavailable: '跨页面选材暂不可用，请等待登录和工作区恢复。',
    draftConflict: '其他页面刚更新了选材，请核对后重试。',
    draftRetry: '重新连接',
    invalidGroup: '请输入有效场景组名称。',
    localUnavailable: '本地工程素材暂时无法读取。',
  },
  homeCards: {
    home: '首页',
    settings: '设置',
    features: '创作功能',
    title: '开始你的下一次创作',
    fission: '超级混剪',
    studio: '创作中心',
    catalog: '素材中心',
    fissionBody: '选择本地文件夹，按场景批量创作。',
    studioBody: '回到原Studio编辑、续编与导出。',
    catalogBody: '浏览本地素材；云端素材接入中。',
    choose: '创作中心可从下方打开或新建工程。',
    studioGuide: '所选工程将在原Studio打开。',
    resume: '返回当前工程',
    recent: '最近工程',
    all: '全部工程',
    myProjects: '本人工程',
    loading: '正在读取本人工程…',
    empty: '当前账号暂无工程，可在下方新建或打开。',
  },
  homeEntry: {
    projects: '项目',
    fission: '超级混剪',
    catalog: '素材中心',
    chooseProject: '请先选择下方的原工程。',
    nextFission: '无需先建工程，直接进入超级混剪。',
    nextCatalog: '无需先建工程，直接进入素材中心。',
  },
  catalog: {
    title: '智尚素材',
    local: '本地素材',
    readOnly: '只读查询已确认的本人云账号目录。不下载原片或缩略图，不上传、登记或自动授予编辑权限。',
    search: '查询',
    refresh: '刷新',
    loading: '正在读取目录…',
    page: '页码',
    noGrant: '仅元数据 · grants: false',
    empty: '本次已授权查询没有返回素材。',
    previous: '上一页',
    next: '下一页',
    binding: '本人云账号绑定尚未确认；本地素材和混剪仍可继续使用。',
    bindingChanged: '云账号绑定已变化，请按当前账号重新查询。',
    config: '业务服务或智尚后台运行凭据待配置；不影响本地素材。',
    denied: '云服务拒绝了当前账号的访问。',
    auth: '请重新登录后查询目录。',
    unknown: '目录结果尚未确认，不代表没有素材；服务恢复后可重试。',
  },
  fissionBatch: {
    import: '导入原始分轨工程',
    importFailed: '无法安全导入原始分轨工程。',
    title: '超级混剪',
    group: '业务组 UUID（资格由业务端实时校验）',
    ready: '批次提交已接线；组资格、素材许可与运行环境仍由业务端实时检查。',
    unavailable: '批次服务未配置，本地编辑与导入仍可使用。',
    candidate: 'rendered-unverified 只是候选结果，不是已交付或已导入工程；仍需实际可编辑源交接。',
    retirementPending: '取消须有真实资源退出证据。未知响应不会释放内容占用或放行换号。',
    VideoDir: '原工程视频目录',
    AudioDir: '原工程配音目录',
    BgmDir: '背景音乐目录（可空）',
    IntroDir: '片头目录（可空）',
    OutroDir: '片尾目录（可空）',
    Count: '输出数量（0 为原生自动数量）',
    Threads: '执行并行数',
    phase: '实际阶段',
    close: '隐藏窗口（不停止任务）',
    cancel: '请求取消并核对状态',
    new: '明确新建批次',
    start: '提交批次',
    retry: '沿用同一请求重试',
    submitting: '提交中…',
    unconfirmed: '无法确认批次状态。',
  },
  material: {
    register: '登记到业务服务（上传）',
    registering: '正在登记此文件…',
    registered: '文件已登记；使用时仍检查当前许可。',
    unknown: '登记结果尚未确认。原文件已保留；重试沿用同一请求。',
    unavailable: '业务服务尚未配置，本地导入与编辑不受影响。',
    stale: '源文件已变化，旧登记不能授权此文件。',
    unregistered: '此文件尚未登记。',
  },
  gallery: {
    skillsIndex: '技能索引',
    empty: '没有可显示的示例。示例从技能索引读取，请检查网络。',
    viewSource: '查看来源',
  },
  settings: {
    servicesLoading: '正在加载服务配置…',
    servicesUnavailable: '服务配置暂不可用。',
    servicesRetry: '重试',
    servicesLimited: '当前隔离环境仅支持本地配置；媒体生成、联网授权和模型安装尚未启用。',
  },
  materialCenter: {
    cloudSteward: '云管家素材',
    closePanel: '收起',
  },
  projects: {
    fetch: {
      error: {
        host: 'Studio 只通过 https 从其技能索引读取示例。',
        network: '无法连接技能索引。请检查网络连接。',
        git: '这个仓库是私有的或不在索引里，需要 git。请安装 git 后重试。',
      },
    },
  },
  assetDrawer: {
    mineEmpty: '从技能索引或本地文件夹导入，导入后所有项目都能用。',
    mineEmptyCli: '在终端运行 orangefilm skill add，从技能索引或文件夹导入，所有项目都能用。',
  },
};

/** 8 paths: the ones we had a Japanese sentence for; the rest read English, as upstream says. */
const ja: Words = {
  gallery: {
    skillsIndex: 'スキル索引',
    empty: '表示できるサンプルがありません。サンプルはスキル索引から読み込みます。接続を確認してください。',
    viewSource: 'ソースを見る',
  },
  projects: {
    fetch: {
      error: {
        host: 'Studio は https でスキル索引からサンプルを読み込みます。',
        network: 'スキル索引に接続できませんでした。インターネット接続を確認してください。',
        git: 'これは非公開か索引の外にあるため、git が必要です。git をインストールしてから、もう一度お試しください。',
      },
    },
  },
  assetDrawer: {
    mineEmpty: 'スキル索引やこのパソコンのフォルダからインポートでき、すべてのプロジェクトで使えます。',
    mineEmptyCli: 'orangefilm skill add でスキル索引やフォルダからインポートでき、すべてのプロジェクトで使えます。',
  },
};

/** 7 paths: the ones we had a Korean sentence for. */
const ko: Words = {
  gallery: {
    empty: '표시할 예시가 없습니다. 예시는 스킬 색인에서 읽어 옵니다. 연결을 확인하세요.',
    viewSource: '소스 보기',
  },
  projects: {
    fetch: {
      error: {
        host: 'Studio는 https로 스킬 색인에서 예시를 읽어 옵니다.',
        network: '색인에 연결할 수 없습니다. 인터넷 연결을 확인하세요.',
        git: '비공개이거나 색인 밖에 있는 저장소라 git이 필요합니다. git을 설치한 뒤 다시 시도하세요.',
      },
    },
  },
  assetDrawer: {
    mineEmpty: '스킬 색인이나 이 컴퓨터의 폴더에서 가져오면 모든 프로젝트에서 쓸 수 있습니다.',
    mineEmptyCli: 'orangefilm skill add로 스킬 색인이나 폴더에서 가져오면 모든 프로젝트에서 쓸 수 있습니다.',
  },
};

/** 8 paths: the ones we had a Spanish sentence for. */
const es: Words = {
  gallery: {
    skillsIndex: 'Índice de skills',
    empty: 'No hay ejemplos que mostrar. Se leen del índice de skills: revisa la conexión.',
    viewSource: 'Ver la fuente',
  },
  projects: {
    fetch: {
      error: {
        host: 'Studio lee sus ejemplos de su índice de skills, solo por https.',
        network: 'No se pudo conectar con el índice. Revisa tu conexión a internet.',
        git: 'Este necesita git: es privado o no está en el índice. Instala git y vuelve a intentarlo.',
      },
    },
  },
  assetDrawer: {
    mineEmpty: 'Importa una del índice de skills o de una carpeta de este equipo; todos los proyectos pueden usarla.',
    mineEmptyCli: 'Ejecuta orangefilm skill add con una skill del índice o una carpeta; todos los proyectos pueden usarla.',
  },
};

/** Our words, per language: what `withOrangeWords` lays over upstream's table. */
export const ORANGE_WORDS: Record<OrangeLanguage, Words> = { en, 'zh-CN': zhCN, ja, ko, es };

/**
 * `base` with our phrases laid over it: a path in both is ours, a path in one is that one's, and neither table is
 * changed. A language we have nothing for keeps upstream's words; a path no table has stays English through the
 * caller's fallback. Nothing here removes a phrase, so no screen loses a word.
 */
function layOver(base: unknown, overlay: unknown): unknown {
  if (!overlay || typeof overlay !== 'object' || Array.isArray(overlay)) return base;
  if (!base || typeof base !== 'object' || Array.isArray(base)) return overlay;
  const out = { ...(base as Record<string, unknown>) };
  for (const [path, value] of Object.entries(overlay as Record<string, unknown>)) {
    out[path] = value && typeof value === 'object' && !Array.isArray(value)
      ? layOver((base as Record<string, unknown>)[path], value)
      : value;
  }
  return out;
}

/**
 * Studio's language list with our words laid over each table: the one place the overlay is applied, so the translator,
 * the search through a screen's phrases and the settings list all read the same tables. Each entry keeps its code and
 * its name; only its `words` is ours-laid-over-upstream's.
 */
export function withOrangeWords<const L extends readonly { readonly code: OrangeLanguage; readonly words: unknown }[]>(languages: L): L {
  return languages.map((language) => ({
    ...language,
    words: layOver(language.words, ORANGE_WORDS[language.code]),
  })) as unknown as L;
}
