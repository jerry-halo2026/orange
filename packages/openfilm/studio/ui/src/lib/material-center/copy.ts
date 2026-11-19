// © 2026 OrangeFilm. All rights reserved. Proprietary and confidential.
// No modification or redistribution without the owner’s written permission.

import type {UseFailureKind} from './use-material.ts';
/**
 * The material centre's words, in the two languages this workspace ships first-class copy for.
 * Kept here rather than in `i18n/*.ts` so the page's sentences travel with the page.
 */
export type MaterialCopy = {
  readonly title: string;
  readonly purpose: string;
  readonly filters: string;
  readonly mainCategory: string;
  readonly oneLevel: string;
  readonly twoLevel: string;
  readonly anyOf: string;
  readonly noneOf: string;
  readonly labels: string;
  readonly author: string;
  readonly authorOwn: string;
  readonly authorCompany: string;
  readonly created: string;
  readonly createdFrom: string;
  readonly createdTo: string;
  readonly sort: string;
  readonly search: string;
  readonly searchHint: string;
  readonly apply: string;
  readonly clear: string;
  readonly pageLocal: string;
  readonly toolbar: string;
  readonly select: string;
  readonly selectOnPage: string;
  readonly clearSelection: string;
  readonly hideUnauthorized: string;
  readonly cards: string;
  readonly list: string;
  readonly selected: (count: number) => string;
  readonly use: string;
  readonly using: string;
  readonly downloads: string;
  readonly collects: string;
  readonly duration: string;
  readonly size: string;
  readonly authorUnknown: string;
  readonly noCover: string;
  readonly loading: string;
  readonly empty: string;
  readonly error: string;
  /** The data plane is not wired in this installation (a 501), not a provider failure. */
  /** No session: the cloud half cannot be read at all (401, or authentication-required). */
  readonly authRequired: string;
  readonly unavailable: string;
  /** The service answered, but its answer could not be used. */
  readonly providerFault: string;
  readonly unauthorized: string;
  readonly retry: string;
  readonly previous: string;
  readonly next: string;
  readonly page: (pageNo: number) => string;
  readonly more: string;
  readonly localAggregate: string;
  readonly metadataOnly: string;
  /** The one library's source filter and its two sources. */
  readonly source: string;
  readonly sourceAll: string;
  readonly sourceLocal: string;
  readonly sourceCloud: string;
  /** Said on a cloud entry until the material is actually in `assets/`, and on a local one. */
  readonly cloudNotDownloaded: string;
  readonly localEntry: string;
  readonly state: string;
  readonly stateAny: string;
  /** The running time, page-local: the supplier has no parameter for it. */
  readonly durationAny: string;
  readonly durationUnderOne: string;
  readonly durationOneToFive: string;
  readonly durationFiveToTwenty: string;
  readonly durationOverTwenty: string;
  /** The local half's dimensions. */
  readonly localProject: string;
  readonly allProjects: string;
  readonly localGroup: string;
  readonly allGroups: string;
  readonly localKind: string;
  readonly anyKind: string;
  readonly kindVideo: string;
  readonly kindImage: string;
  readonly kindAudio: string;
  readonly kindPage: string;
  readonly kindOther: string;
  readonly insertLocal: string;
  readonly importLocal: string;
  /** Why a dimension is greyed: the cloud half is not connected, or the entry is not from that half. */
  readonly cloudOffline: string;
  readonly cloudAuth: string;
  readonly cloudFault: string;
  readonly localOffline: string;
  readonly dimensionCloudOnly: string;
  readonly dimensionLocalOnly: string;
  /** The library's own empty states, per source. */
  readonly emptyAll: string;
  readonly emptyLocal: string;
  readonly emptyCloud: string;
  readonly emptyCloudOffline: string;
  /** The one-time sentence before the first real download, and what a failed download says. */
  readonly useSpendNotice: string;
  /** The cloud card's one action: it downloads into Saved, so it is named for that. */
  readonly download: string;
  readonly useUnavailable: string;
  /** A server that still expects this download to land in a project (older contract). */
  readonly useNeedsNoProject: string;
  /** The three sources' own words: the library a download lands in, and the project a material is taken into. */
  readonly sourceLibrary: string;
  readonly sourceProject: string;
  readonly projectEntry: string;
  readonly takeToProject: string;
  readonly takeNoProject: string;
  readonly takeSignedOut: string;
  readonly takeService: string;
  readonly takeLanded: string;
  readonly useAlreadyInLibrary: string;
  readonly useLandedInLibrary: string;
  /** What a download that also landed in the open project's `assets/` says (the 导入 list's place, named when known). */
  readonly useLandedInProject: (path: string | null) => string;
  readonly emptyLibrary: string;
  readonly libraryOffline: string;
  readonly takeUnavailable: string;
  readonly takeForbidden: string;
  readonly takeTimeout: string;
  readonly takeUnsupported: string;
  readonly takeFailed: string;
  /** A 200 with no rows because the authorization layer dropped every one of them: filtered, not refused. */
  readonly filteredEmpty: (dropped: number) => string;
  readonly switchToCompany: string;
  /** The Studio guard said 401 and the client is retrying: a session warming up, not a refusal. */
  readonly studioSessionRetrying: string;
  /** The claim itself could not be read: about the binding, never about reading cloud material. */
  readonly bindingReadAuth: string;
  readonly bindingReadOffline: string;
  readonly bindingReadUnknown: string;
  /** Claiming the one cloud-steward account "my materials" is scoped to (no cloud-steward login). */
  readonly bindingUnbound: string;
  readonly bindingAction: string;
  readonly bindingAccountLabel: string;
  readonly bindingAccountHint: string;
  readonly bindingSubmit: string;
  readonly bindingCancel: string;
  readonly bindingClaimed: (account: string) => string;
  readonly bindingRelease: string;
  readonly bindingAccountNotFound: string;
  readonly bindingInvalidAccount: string;
  readonly bindingRequesting: string;
  readonly bindingReleasing: string;
  readonly ownNeedsBinding: string;
  readonly useForbidden: string;
  /** The wiki's entry on a card. */
  readonly wiki: string;
  /** A 403 that is about the storage host's allow-list (a configuration), not about who the person is. */
  readonly useStorageBlocked: string;
  readonly useTimeout: string;
  readonly useUnsupported: string;
  readonly useFailed: string;
  readonly retryUse: string;
  /** The two views the toggle switches between, and the tree's own words. */
  readonly viewToggle: string;
  readonly viewVideos: string;
  readonly viewCollections: string;
  readonly allBatches: string;
  readonly collectionCount: (count: number) => string;
  readonly indexPending: string;
  readonly indexFailed: string;
  readonly indexEmpty: string;
  readonly indexApproximate: (rows: number) => string;
  /** One 子合集's own read: the supplier's total for that prefix, and how many of its rows are loaded. */
  readonly groupPage: (total: number | null, loaded: number) => string;
  /** Nothing came back for that prefix (a real empty group, not "the page we happened to have"). */
  readonly groupEmpty: string;
  readonly groupLoadMore: string;
  /** The row that replaces the button once the loaded rows reach the total. */
  readonly groupLoadedAll: (loaded: number) => string;
  /** What the supplier claims against what it will serve, and the derived layer's own two stage headings. */
  readonly indexReach: (pageable: number, sourceTotal: number, unreachable: number) => string;
  /** Which index the 合集 view is drawing: the one landed on this computer, or the budgeted page walk that fell back. */
  readonly indexSource: (source: 'landed' | 'probing', rows: number, generatedAt: string | null) => string;
  /** Said over a landed index that is past its own `staleAfterMs`: the data stays, the fact is not hidden. */
  readonly indexStale: string;
  readonly derivedStage: string;
  readonly unfiledStage: string;
  /** 派生批次 are a list, not a place: how many there are, and how many of them this view lists. */
  readonly derivedMore: (total: number, shown: number) => string;
  readonly unassignedCount: (count: number) => string;
  readonly unassignedHint: string;
  /** The detail sheet: what it names, and the way out. */
  readonly detailTagPath: string;
  readonly detailNoTagPath: string;
  readonly detailClose: string;
  readonly detailBack: string;
};

const zh: MaterialCopy = {
  title: '素材中心',
  purpose: '只读素材列表：封面与计数来自供应商；使用/下载会把文件真实下载一次到本地。',
  filters: '筛选',
  mainCategory: '主类目',
  oneLevel: '一级分类',
  twoLevel: '二级分类',
  anyOf: '全部',
  noneOf: '不限',
  labels: '公共标签',
  author: '作者',
  authorOwn: '我的素材（我上传的）',
  authorCompany: '公司素材（全部）',
  created: '创建时间',
  createdFrom: '起',
  createdTo: '止',
  sort: '排序',
  search: '搜索',
  searchHint: '标题或描述',
  apply: '应用',
  clear: '清除筛选',
  pageLocal: '本页内',
  toolbar: '工具条',
  select: '选择',
  selectOnPage: '选中本页',
  clearSelection: '清除选择',
  hideUnauthorized: '过滤无权限',
  cards: '卡片',
  list: '列表',
  selected: count => `已选 ${count} 条`,
  use: '使用/下载',
  using: '处理中…',
  downloads: '下载',
  collects: '收藏',
  duration: '时长',
  size: '大小',
  authorUnknown: '作者未知',
  noCover: '暂无封面',
  loading: '正在读取素材…',
  empty: '没有可展示的素材。',
  error: '读取失败，本次结果不作数。',
  authRequired: '需要登录后才能读取云端素材。',
  unavailable: '素材服务未接通：这次没有读取云端素材（与素材本身无关）。',
  providerFault: '素材服务已接通，但本次响应不可用；结果不作数。',
  unauthorized: '当前身份没有查看这批素材的权限。',
  retry: '重试',
  previous: '上一页',
  next: '下一页',
  page: pageNo => `第 ${pageNo} 页`,
  more: '还有更多',
  localAggregate: '本地聚合',
  metadataOnly: '只读取元数据与封面，不请求任何原片。',
  source: '来源',
  sourceAll: '全部',
  sourceLocal: '本地',
  sourceCloud: '云端',
  cloudNotDownloaded: '云端未下载',
  localEntry: '本地素材',
  state: '状态',
  stateAny: '全部状态',
  durationAny: '全部时长',
  durationUnderOne: '1 分钟以内',
  durationOneToFive: '1–5 分钟',
  durationFiveToTwenty: '5–20 分钟',
  durationOverTwenty: '20 分钟以上',
  localProject: '来源工程',
  allProjects: '全部工程',
  localGroup: '素材分组',
  allGroups: '全部分组',
  localKind: '本地类型',
  anyKind: '全部类型',
  kindVideo: '视频',
  kindImage: '图片',
  kindAudio: '音频',
  kindPage: '页面',
  kindOther: '其它',
  insertLocal: '加入时间线',
  importLocal: '导入本地文件',
  cloudOffline: '素材服务未接通：云端筛选已灰显，本地素材仍可用。',
  cloudAuth: '当前身份无权读取云端素材：云端筛选已灰显，本地素材仍可用。',
  cloudFault: '云端读取失败：云端筛选已灰显，本地素材仍可用。',
  localOffline: '本地工程素材暂时无法读取；云端素材不受影响。',
  dimensionCloudOnly: '仅云端素材有此维度',
  dimensionLocalOnly: '仅本地素材有此维度',
  emptyAll: '没有匹配的素材。',
  emptyLocal: '本地没有匹配的素材。',
  emptyCloud: '云端没有匹配的素材。',
  emptyCloudOffline: '云端未接通，没有可显示的素材。',
  useSpendNotice: '使用/下载会把文件真实下载一次到本地；完成后素材出现在「素材库」里。',
  download: '下载',
  useUnavailable: '下载未接通：素材服务没有响应，本次没有取到文件。',
  useNeedsNoProject: '下载本不需要工程：服务端版本不一致，本次没有取到文件。',
  sourceLibrary: '素材库',
  sourceProject: '当前工程',
  projectEntry: '当前工程',
  takeToProject: '加到当前工程',
  takeNoProject: '没有打开的工程，先打开一个工程再加',
  takeSignedOut: '未登录：不能把素材加入工程',
  takeService: '素材库服务未接通：暂时不能加入工程',
  takeLanded: '已加入当前工程，可在“当前工程”来源里看到。',
  useAlreadyInLibrary: '已在素材库：本次没有重复下载。',
  useLandedInLibrary: '已下载到素材库，可在“素材库”来源里看到。',
  useLandedInProject: path => path
    ? `已下载并加入当前工程：${path}，在「导入」里可以直接用。`
    : '已下载并加入当前工程，在「导入」里可以直接用。',
  emptyLibrary: '素材库里没有匹配的文件。',
  libraryOffline: '素材库暂时读不到（服务未接通或未登录）；云端与当前工程素材不受影响。',
  takeUnavailable: '加入工程未接通：素材库服务没有响应，本次没有加入。',
  takeForbidden: '当前身份无权把这条素材加入工程。',
  takeTimeout: '加入工程超时：本次结果不作数，可以重试。',
  takeUnsupported: '这条素材无法加入工程（类型或大小不支持，或文件已不存在）。',
  takeFailed: '加入工程失败：本次结果不作数。',
  filteredEmpty: dropped => `本页已按授权过滤（丢弃 ${dropped} 条）。`,
  switchToCompany: '切换到公司视图',
  studioSessionRetrying: 'Studio 会话未就绪，正在重试…',
  bindingReadAuth: '绑定状态需要登录后才能读取；「我的素材」暂不可用（云端目录与当前工程不受影响）。',
  bindingReadOffline: '绑定服务未接通；「我的素材」暂不可用（云端目录与当前工程不受影响）。',
  bindingReadUnknown: '绑定状态读取失败；「我的素材」暂不可用（云端目录与当前工程不受影响）。',
  bindingUnbound: '尚未绑定云管家账号，绑定后才能使用「我的素材」。',
  bindingAction: '绑定',
  bindingAccountLabel: '云管家账号',
  bindingAccountHint: '输入云管家账号（不需要登录云管家）',
  bindingSubmit: '绑定',
  bindingCancel: '取消',
  bindingClaimed: account => `已绑定云管家账号：${account}（已认领）`,
  bindingRelease: '解绑',
  bindingAccountNotFound: '账号不存在或名称不精确。',
  bindingInvalidAccount: '请输入云管家账号。',
  bindingRequesting: '正在绑定…',
  bindingReleasing: '正在解绑…',
  ownNeedsBinding: '需要先绑定云管家账号，才能使用「我的素材」',
  useForbidden: '当前身份无权下载这条素材。',
  wiki: '纪要',
  useStorageBlocked: '该素材的存储位置未被放行（属于配置问题，不是权限问题）。请联系管理员白名单放行后再试。',
  useTimeout: '下载超时：本次结果不作数，可以重试。',
  useUnsupported: '这条素材过大或类型不支持下载，重试也不会改变结果。',
  useFailed: '下载失败：本次结果不作数。',
  retryUse: '重试下载',
  viewToggle: '视图',
  viewVideos: '视频',
  viewCollections: '合集',
  allBatches: '全部',
  collectionCount: count => `${count} 条`,
  indexPending: '正在建立索引…',
  indexFailed: '索引建立失败：合集视图暂不可用（视频视图不受影响）。',
  indexEmpty: '索引里还没有可展示的批次。',
  indexApproximate: rows => `索引读到的 ${rows} 条素材；没读到的批次不在这里。`,
  groupPage: (total, loaded) => total === null
    ? `该分组已加载 ${loaded} 条（供应商未给出总数）。`
    : `该分组共 ${total} 条，已加载 ${loaded} 条。`,
  groupEmpty: '该分组暂无素材。',
  groupLoadMore: '加载更多',
  groupLoadedAll: loaded => `已全部加载 ${loaded} 条`,
  indexReach: (pageable, sourceTotal, unreachable) => `可翻页 ${pageable} / 声称 ${sourceTotal}（差额 ${unreachable} 不可达）`,
  indexSource: (source, rows, generatedAt) => source === 'landed'
    ? `索引来源：已落盘 · ${rows} 条 · 生成于 ${generatedAt ?? '未知时间'}`
    : `索引来源：现抓（最多 800 条）· 读到 ${rows} 条`,
  indexStale: '索引已过期，可重建。',
  derivedStage: '派生批次（名称开头的日期 / 编号，不是批次号）',
  unfiledStage: '未归档（按分组词 / 序号）',
  derivedMore: (total, shown) => `共 ${total} 个派生批次，只显示前 ${shown} 个`,
  unassignedCount: count => `未归类 ${count} 条`,
  unassignedHint: '这些名称里没有批次、日期、分组词或序号：不建组，也不画卡片墙。',
  detailTagPath: '标签路径',
  detailNoTagPath: '名称里没有批次/合集/分组',
  detailClose: '关闭',
  detailBack: '返回',
};

const en: MaterialCopy = {
  title: 'Material center',
  purpose: 'A read-only material list: covers and counts come from the supplier; use/download fetches the file once.',
  filters: 'Filters',
  mainCategory: 'Category',
  oneLevel: 'Group',
  twoLevel: 'Subgroup',
  anyOf: 'All',
  noneOf: 'Any',
  labels: 'Labels',
  author: 'Author',
  authorOwn: 'Mine (uploaded by me)',
  authorCompany: 'Company material (all)',
  created: 'Created',
  createdFrom: 'from',
  createdTo: 'to',
  sort: 'Sort',
  search: 'Search',
  searchHint: 'title or description',
  apply: 'Apply',
  clear: 'Clear filters',
  pageLocal: 'this page',
  toolbar: 'Toolbar',
  select: 'Select',
  selectOnPage: 'Select this page',
  clearSelection: 'Clear selection',
  hideUnauthorized: 'Hide unauthorized',
  cards: 'Cards',
  list: 'List',
  selected: count => `${count} selected`,
  use: 'Use / download',
  using: 'Working…',
  downloads: 'Downloads',
  collects: 'Saves',
  duration: 'Length',
  size: 'Size',
  authorUnknown: 'Unknown author',
  noCover: 'No cover',
  loading: 'Reading materials…',
  empty: 'No material to show.',
  error: 'The read failed; this result does not count.',
  authRequired: 'Sign in to read cloud materials.',
  unavailable: 'The material service is not connected here; nothing was read from the cloud.',
  providerFault: 'The material service answered, but the answer could not be used.',
  unauthorized: 'This identity may not see these materials.',
  retry: 'Retry',
  previous: 'Previous',
  next: 'Next',
  page: pageNo => `Page ${pageNo}`,
  more: 'More available',
  localAggregate: 'local aggregate',
  metadataOnly: 'Metadata and covers only; no source file is ever requested.',
  source: 'Source',
  sourceAll: 'All',
  sourceLocal: 'Local',
  sourceCloud: 'Cloud',
  cloudNotDownloaded: 'Not downloaded',
  localEntry: 'Local asset',
  state: 'Status',
  stateAny: 'Any status',
  durationAny: 'Any length',
  durationUnderOne: 'Under 1 min',
  durationOneToFive: '1–5 min',
  durationFiveToTwenty: '5–20 min',
  durationOverTwenty: 'Over 20 min',
  localProject: 'Project',
  allProjects: 'All projects',
  localGroup: 'Asset group',
  allGroups: 'All groups',
  localKind: 'Local kind',
  anyKind: 'Any kind',
  kindVideo: 'Video',
  kindImage: 'Image',
  kindAudio: 'Audio',
  kindPage: 'Page',
  kindOther: 'Other',
  insertLocal: 'Add to timeline',
  importLocal: 'Import local files',
  cloudOffline: 'The material service is not connected: cloud filters are greyed out, local assets still work.',
  cloudAuth: 'This identity may not read cloud material: cloud filters are greyed out, local assets still work.',
  cloudFault: 'The cloud read failed: cloud filters are greyed out, local assets still work.',
  localOffline: 'The local project assets cannot be read right now; cloud material is unaffected.',
  dimensionCloudOnly: 'cloud entries only',
  dimensionLocalOnly: 'local entries only',
  emptyAll: 'No material matches.',
  emptyLocal: 'No local material matches.',
  emptyCloud: 'No cloud material matches.',
  emptyCloudOffline: 'The cloud is not connected, so there is no material to show.',
  useSpendNotice: 'Use/download fetches the file once; the material then shows up among your local assets.',
  download: 'Download',
  useUnavailable: 'The download service is not connected: nothing was fetched.',
  useNeedsNoProject: 'A download needs no project: the server is on an older contract, so nothing was fetched.',
  sourceLibrary: 'Library',
  sourceProject: 'Current project',
  projectEntry: 'Current project',
  takeToProject: 'Add to project',
  takeNoProject: 'No project is open; open one first',
  takeSignedOut: 'Not signed in: the material cannot be added to a project',
  takeService: 'The library service is not connected: adding to a project is unavailable',
  takeLanded: 'Added to the current project; it is in the “Current project” source now.',
  useAlreadyInLibrary: 'Already in the library: nothing was downloaded again.',
  useLandedInLibrary: 'Downloaded to the library; it is in the “Library” source now.',
  useLandedInProject: path => path
    ? `Downloaded and added to the current project: ${path} — it is usable from 导入 now.`
    : 'Downloaded and added to the current project — it is usable from 导入 now.',
  emptyLibrary: 'No library file matches.',
  libraryOffline: 'The library cannot be read right now (not connected or not signed in); cloud and project materials are unaffected.',
  takeUnavailable: 'Adding to the project is not connected: the library service did not answer, so nothing was added.',
  takeForbidden: 'This identity may not add that material to a project.',
  takeTimeout: 'Adding to the project timed out; this result does not count. You can retry.',
  takeUnsupported: 'This material cannot be added to the project (its type or size is not supported, or the file is gone).',
  takeFailed: 'Adding to the project failed; this result does not count.',
  filteredEmpty: dropped => `This page was filtered by authorization (${dropped} dropped).`,
  switchToCompany: 'Switch to company view',
  studioSessionRetrying: 'The Studio session is not ready yet; retrying…',
  bindingReadAuth: 'Reading your claim needs a sign-in; “My materials” is unavailable meanwhile (cloud and project material are unaffected).',
  bindingReadOffline: 'The binding service is not connected; “My materials” is unavailable meanwhile (cloud and project material are unaffected).',
  bindingReadUnknown: 'Your claim could not be read; “My materials” is unavailable meanwhile (cloud and project material are unaffected).',
  bindingUnbound: 'No cloud-steward account is claimed yet; claim one to use “My materials”.',
  bindingAction: 'Claim',
  bindingAccountLabel: 'Cloud-steward account',
  bindingAccountHint: 'The cloud-steward account name (no cloud-steward sign-in needed)',
  bindingSubmit: 'Claim',
  bindingCancel: 'Cancel',
  bindingClaimed: account => `Cloud-steward account claimed: ${account}`,
  bindingRelease: 'Release',
  bindingAccountNotFound: 'That account does not exist, or its name is not exact.',
  bindingInvalidAccount: 'Enter the cloud-steward account name.',
  bindingRequesting: 'Claiming…',
  bindingReleasing: 'Releasing…',
  ownNeedsBinding: 'Claim a cloud-steward account before using “My materials”.',
  useForbidden: 'This identity may not download that material.',
  wiki: 'Notes',
  useStorageBlocked: 'That material sits on a storage host this app is not allowed to read (a configuration issue, not a permission one).',
  useTimeout: 'The download timed out; this result does not count. You can retry.',
  useUnsupported: 'This material is too large, or its type cannot be downloaded; retrying cannot change that.',
  useFailed: 'The download failed; this result does not count.',
  retryUse: 'Retry download',
  viewToggle: 'View',
  viewVideos: 'Videos',
  viewCollections: 'Collections',
  allBatches: 'All',
  collectionCount: count => `${count} items`,
  indexPending: 'Building the index…',
  indexFailed: 'The index could not be built: the collections view is unavailable (the videos view is not).',
  indexEmpty: 'The index has no batch to show yet.',
  indexApproximate: rows => `The index read ${rows} materials; batches it did not reach are not here.`,
  groupPage: (total, loaded) => total === null
    ? `${loaded} loaded for this group (the supplier stated no total).`
    : `${loaded} of ${total} materials loaded for this group.`,
  groupEmpty: 'This group has no material.',
  groupLoadMore: 'Load more',
  groupLoadedAll: loaded => `All ${loaded} materials loaded`,
  indexReach: (pageable, sourceTotal, unreachable) => `${pageable} pageable / ${sourceTotal} claimed (${unreachable} unreachable)`,
  indexSource: (source, rows, generatedAt) => source === 'landed'
    ? `Index source: landed · ${rows} items · built ${generatedAt ?? 'at an unstated time'}`
    : `Index source: probed live (at most 800) · ${rows} items read`,
  indexStale: 'The index is stale; it can be rebuilt.',
  derivedStage: 'Derived batches (the date / number the name opens with — not a batch id)',
  unfiledStage: 'Unfiled (by group word / sequence)',
  derivedMore: (total, shown) => `${total} derived batches in all; the first ${shown} are listed`,
  unassignedCount: count => `${count} unclassified`,
  unassignedHint: 'These names carry no batch, date, group word or sequence: no group is invented and no card wall is drawn.',
  detailTagPath: 'Tag path',
  detailNoTagPath: 'The name carries no batch / collection / group',
  detailClose: 'Close',
  detailBack: 'Back',
};

export function copyFor(language: string): MaterialCopy {
  return language === 'zh-CN' ? zh : en;
}

/**
 * Which sentence a failure earns. The status and code decide; the page never guesses.
 *
 * The tiers, in this order: no session (401, or the server's own `authentication-required` — even on a 403) is "sign
 * in", because the person can do something about it; a service that is not mounted (501) is "not connected"; the other
 * 403s are "this identity may not"; a provider answer that cannot be used is its own sentence; everything else is the
 * plain failure — never the server's `internal-error` code shown as if the person could read it.
 */
export function failureCopy(copy: MaterialCopy, failure: {code?: string; status?: number} | null): string {
  if (!failure) return copy.error;
  if (failure.status === 401 || failure.code === 'authentication-required') return copy.authRequired;
  if (failure.code === 'material-service-unavailable' || failure.status === 501) return copy.unavailable;
  /* A permission refusal is named by its status *or* by its code: a hop that kept only one of them must not turn it
     into the generic failure. */
  if (failure.status === 403 || failure.code === 'authorization-denied' || failure.code === 'origin-rejected') return copy.unauthorized;
  if (typeof failure.code === 'string' && failure.code.startsWith('provider-')) return copy.providerFault;
  return copy.error;
}
/** Why a use/download earned its sentence. The class decides; the code is named only for the unknown case. */
export function useFailureCopy(copy: MaterialCopy, kind: UseFailureKind | null | undefined, code?: string): string {
  if (kind === 'auth') return copy.authRequired;
  if (kind === 'unavailable' && code === 'project-not-found') return copy.useNeedsNoProject;
  if (kind === 'unavailable') return copy.useUnavailable;
  /* Two 403s, two different people to ask: the storage host's allow-list is a configuration fix, not a permission one. */
  if (kind === 'forbidden') return code === 'raw-host-not-allowed' ? copy.useStorageBlocked : copy.useForbidden;
  if (kind === 'timeout') return copy.useTimeout;
  if (kind === 'unsupported') return copy.useUnsupported;
  return code ? copy.useFailed + '（' + code + '）' : copy.useFailed;
}

/**
 * What a download says: a fresh landing, or one the library already had (contract §9 `reused`, no download spent).
 * `intoProject` is the second hop the host took when a project is open (`landDownloadInProject`): the material is in
 * the project's `assets/` too, so the sentence names the place the 导入 list shows instead of only the library.
 */
export function downloadNotice(copy: MaterialCopy, reused: boolean, intoProject: {readonly path: string | null} | null = null): string {
  if (intoProject) return copy.useLandedInProject(intoProject.path);
  return reused ? copy.useAlreadyInLibrary : copy.useLandedInLibrary;
}

/** Why adding one Saved file to the open project earned its sentence. Same five classes as a download. */
export function takeFailureCopy(copy: MaterialCopy, kind: UseFailureKind | null | undefined, code?: string): string {
  if (kind === 'auth') return copy.authRequired;
  if (kind === 'unavailable') return copy.takeUnavailable;
  if (kind === 'forbidden') return copy.takeForbidden;
  if (kind === 'timeout') return copy.takeTimeout;
  if (kind === 'unsupported') return copy.takeUnsupported;
  return code ? copy.takeFailed + '（' + code + '）' : copy.takeFailed;
}
