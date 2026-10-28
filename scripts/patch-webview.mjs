import fs from 'node:fs/promises';import path from 'node:path';
import {patchClientServices} from './client-capabilities-patch.mjs';
import {patchNavigationLayout} from './navigation-layout-patch.mjs';
import {patchSkillMentionDisplay} from './skill-mention-display-patch.mjs';
import {patchBrowserEvaluations} from './browser-evaluations-patch.mjs';
import {patchUnarchive} from './unarchive-patch.mjs';
import {patchFeatureConfigTransport} from './feature-config-patch.mjs';
import {patchSidebarDrag} from './sidebar-drag-patch.mjs';
import {patchUngroupedPinned} from './ungrouped-pinned-patch.mjs';
import {patchContextUsageButton} from './context-usage-button-patch.mjs';
import {patchDraftPersistence,patchDraftSubmission} from './composer-draft-patch.mjs';
import {patchSidebarStatus} from './sidebar-status-patch.mjs';
import {patchNativeOpen} from './native-open-patch.mjs';
import {patchServiceTier} from './service-tier-patch.mjs';
import {patchImagePreviewInitial} from './image-preview-patch.mjs';
import {patchBrowserFonts,patchFontMenu} from './browser-fonts-patch.mjs';
import {patchBrowserAttachments,patchBrowserAttachmentCapability} from './browser-attachments-patch.mjs';
import {patchStartupWork} from './startup-work-patch.mjs';
import {patchBrowserUploads} from './browser-upload-patch.mjs';
import {patchReasoningLabels} from './model-labels-patch.mjs';
import {patchAgentTitleMetadata,patchAgentTitleRows,patchAgentTitleHeader,patchAgentActivityTitles} from './agent-titles-patch.mjs';
import {patchSubagentHistory,patchSubagentPanel,patchSubagentVerification} from './subagent-history-patch.mjs';
import {patchBrowserView,patchBrowserToolbar} from './browser-view-patch.mjs';
import {patchVisualizationHandshake,patchVisualizationFrames,patchVisualizationEntry,buildVisualizationSandbox} from './visualization-sandbox-patch.mjs';
import {patchSub2ApiUsage,patchSub2ApiTrigger} from './sub2api-ui-patch.mjs';
import {patchSubagentInheritance} from './subagent-inheritance-patch.mjs';
import {patchActivityEntrypoint,patchActivityProjectIcon,patchPickedImageMime,patchMobileNewTabs,patchMobileHistoryNavigation,patchSidebarPagination} from './mobile-native-patch.mjs';
import {patchFollowupSubmission,patchInactiveSteer} from './followup-delivery-patch.mjs';
import {patchIdleThreadOwnership} from './thread-ownership-patch.mjs';
import {patchBrowserAppInfo} from './browser-app-info-patch.mjs';
import {patchLatestHistoryTail} from './history-tail-patch.mjs';
import {patchAsyncQuestionSync,patchAsyncQuestionGroups} from './async-question-sync-patch.mjs';
import {patchActivityFreshnessInitial,patchActivityFreshnessShared} from './activity-freshness-patch.mjs';
import {patchActivityQuestionAnswers} from './activity-question-answers-patch.mjs';
import {patchUnreadCatalogState,patchConversationOpening} from './chat-loading-patch.mjs';
import {patchMobileSettings} from './mobile-settings-patch.mjs';
import {patchPlanClick} from './plan-click-patch.mjs';
import {patchMcpAppFrames,patchMcpAppHandshake,patchMcpAppSurface,patchMcpAppWorkspace,patchBrowserLocalImages,patchCodeReviewGitHubScope,buildMcpAppSandbox} from './mcp-app-sandbox-patch.mjs';
export async function patchWebview(root='scratch/asar/webview/assets'){
 const entries=[
 ['app-initial-6350d04672d0.js',[patchCodeReviewGitHubScope,patchMcpAppWorkspace,patchServiceTier,patchImagePreviewInitial,patchBrowserAttachments,patchBrowserUploads,patchUngroupedPinned,patchSubagentInheritance,patchSub2ApiTrigger,patchActivityEntrypoint,patchActivityProjectIcon,patchMobileNewTabs,patchMobileHistoryNavigation,patchSidebarPagination,patchAsyncQuestionSync,patchActivityFreshnessInitial,patchUnreadCatalogState,s=>s.replace('return sp(lm.theme) ?? `system`;','return `system`;')]],
 ['app-shared-8bd9d0399038.js',[patchSubagentHistory,patchAgentTitleMetadata,patchSidebarStatus,patchDraftPersistence,patchNativeOpen,patchBrowserFonts,patchBrowserView,patchIdleThreadOwnership,patchBrowserAppInfo,patchInactiveSteer,patchLatestHistoryTail,patchActivityFreshnessShared,patchActivityQuestionAnswers,patchAsyncQuestionGroups,patchConversationOpening,patchUnarchive,s=>s.includes('k3 as codexWebConversationField')?s:s+'\nexport {k3 as codexWebConversationField};\n']],
 ['app-primary-6f60e9ac4103.js',[patchAgentTitleRows,patchDraftSubmission,patchContextUsageButton,patchBrowserAttachmentCapability,patchPickedImageMime,patchFollowupSubmission]],
 ['profile-dropdown-items-d842ad78cd70.js',[patchSub2ApiUsage]],
 ['general-settings-65e65871cdcd.js',[patchFontMenu]],
 ['settings-page-50e3fab957b6.js',[patchMobileSettings]],
 ['local-conversation-page-a83a1af2c24b.js',[patchAgentTitleHeader]],
 ['sites-end-resource-78b98c374310.js',[patchAgentActivityTitles,patchPlanClick]],
 ['tab-content-24fe1f531bbe.js',[patchBrowserToolbar]],
 ['open-local-conversation-subagents-panel-5abfac9190b9.js',[patchSubagentPanel]],
 ['verify-descendant-d02f27822163.js',[patchSubagentVerification]],
 ['mcp-sandbox-rpc-31ca1981dbc5.js',[patchVisualizationHandshake,patchMcpAppHandshake]],
 ['widget-e1674d393867.js',[patchMcpAppFrames]],
 ['global-view-a835288022ba.js',[patchMcpAppSurface]],
 ['visualization-thread-frames-fa89561a3a36.js',[patchVisualizationFrames]],
 ['visualization-directive-renderer-4fb52b2afe5f.js',[patchVisualizationEntry]],
 ];
 for(const [file,patches] of entries){let s=(await fs.readFile(path.join(root,file),'utf8')).replaceAll('\r\n','\n');for(const patch of patches)s=await patch(s);if(file.startsWith('app-shared-'))s=patchClientServices(s);await fs.writeFile(path.join(root,file),s);console.log('Patched',file)}
 const initialPath=path.join(root,'app-initial-6350d04672d0.js');
 await fs.writeFile(initialPath,patchSkillMentionDisplay(patchSidebarDrag(await patchStartupWork(patchFeatureConfigTransport(await fs.readFile(initialPath,'utf8'))))));
 for(const name of await fs.readdir(root))if(/^zh-(CN|HK|TW)-.*\.js$/.test(name)){const p=path.join(root,name),s=await fs.readFile(p,'utf8');if(s.includes('composer.mode.local.reasoning.none.label'))await fs.writeFile(p,patchReasoningLabels(s))}
 await buildVisualizationSandbox(root);
 await buildMcpAppSandbox(root);
 const sharedPath=path.join(root,'app-shared-8bd9d0399038.js');
 await fs.writeFile(sharedPath,await patchBrowserEvaluations(patchNavigationLayout(patchBrowserLocalImages(await fs.readFile(sharedPath,'utf8')))));
}
if(process.argv[1]?.endsWith('patch-webview.mjs'))await patchWebview(process.argv[2]);
