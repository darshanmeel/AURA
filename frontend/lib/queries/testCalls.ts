// Test-only: one call list covering every exported query function, shared by
// the smoke test and the read-DB contract test (spec §6.7).
import * as agents from './agents'
import * as apps from './apps'
import * as dashboard from './dashboard'
import * as errors from './errors'
import * as files from './files'
import * as observability from './observability'
import * as people from './people'
import * as prompts from './prompts'
import * as sessions from './sessions'
import { rangeSince, type RangeKey } from '../range'

export const MODULES = { agents, apps, dashboard, errors, files, observability, people, prompts, sessions }

export interface Ids { session: string; app: string; agent: string; person: string; project: string }

export function allCalls(ids: Ids): Record<string, Array<() => unknown>> {
  const sinces = (['today', '7d', '30d', 'all'] as RangeKey[]).map(r => rangeSince(r))
  const each = (f: (since: string | null) => unknown) => sinces.map(s => () => f(s))
  const once = (f: () => unknown) => [f]
  const filters: sessions.SessionFilters = { provider: 'Anthropic', agent: ids.agent, status: 'completed', sort: 'cost', q: 'a' }
  return {
    'agents.getAllAgents': each(s => agents.getAllAgents(s)),
    'agents.getAgent': once(() => agents.getAgent(ids.agent)),
    'agents.getAgentApps': each(s => agents.getAgentApps(ids.agent, s)),
    'agents.getAgentModels': each(s => agents.getAgentModels(ids.agent, s)),
    'agents.getAgentSessions': each(s => agents.getAgentSessions(ids.agent, 12, s)),
    'agents.getAgentPeople': each(s => agents.getAgentPeople(ids.agent, s)),
    'agents.getAgentFiles': each(s => agents.getAgentFiles(ids.agent, 8, s)),
    'agents.getAgentSkills': each(s => agents.getAgentSkills(ids.agent, s)),
    'agents.getAgentMcps': each(s => agents.getAgentMcps(ids.agent, s)),
    'agents.getAgentRangeAggregates': each(s => agents.getAgentRangeAggregates(ids.agent, s)),
    'apps.getApps': each(s => apps.getApps(s)),
    'apps.getAppsTotalCost': each(s => apps.getAppsTotalCost(s)),
    'apps.getProjectApps': once(() => apps.getProjectApps(ids.project)),
    'apps.getApp': once(() => apps.getApp(ids.app)),
    'apps.getAppAgents': each(s => apps.getAppAgents(ids.app, s)),
    'apps.getAppSessions': each(s => apps.getAppSessions(ids.app, 12, s)),
    'apps.getAppSkills': each(s => apps.getAppSkills(ids.app, s)),
    'apps.getAppMcps': each(s => apps.getAppMcps(ids.app, s)),
    'apps.getAppPeople': each(s => apps.getAppPeople(ids.app, s)),
    'apps.getAppRangeAggregates': each(s => apps.getAppRangeAggregates(ids.app, s)),
    'dashboard.getDashboardKPIs': each(s => dashboard.getDashboardKPIs(s)),
    'dashboard.getDailySpend': [...each(s => dashboard.getDailySpend(s)), () => dashboard.getDailySpend(null, null)],
    'dashboard.getTokenSeries': [...each(s => dashboard.getTokenSeries(s, false)), () => dashboard.getTokenSeries(sinces[0], true)],
    'dashboard.getTokenSeriesByModel': [...each(s => dashboard.getTokenSeriesByModel(s, false)), () => dashboard.getTokenSeriesByModel(sinces[0], true)],
    'dashboard.getTokenSeriesByProvider': [...each(s => dashboard.getTokenSeriesByProvider(s, false)), () => dashboard.getTokenSeriesByProvider(sinces[0], true)],
    'dashboard.getTokenByAgent': each(s => dashboard.getTokenByAgent(s)),
    'dashboard.getTopApps': each(s => dashboard.getTopApps(s)),
    'dashboard.getTopProjects': each(s => dashboard.getTopProjects(s)),
    'dashboard.getTopAgents': each(s => dashboard.getTopAgents(s)),
    'dashboard.getToolMix': each(s => dashboard.getToolMix(s)),
    'dashboard.getProviderSplit': each(s => dashboard.getProviderSplit(s)),
    'dashboard.getModelBreakdown': each(s => dashboard.getModelBreakdown(s)),
    'dashboard.getRecentErrors': each(s => dashboard.getRecentErrors(s)),
    'dashboard.getTopFiles': each(s => dashboard.getTopFiles(s)),
    'dashboard.getTopPeople': each(s => dashboard.getTopPeople(s)),
    'dashboard.getSpendPace': once(() => dashboard.getSpendPace()),
    'dashboard.getTopSkills': each(s => dashboard.getTopSkills(s)),
    'dashboard.getTopMcps': each(s => dashboard.getTopMcps(s)),
    'dashboard.getHourlyActivity': once(() => dashboard.getHourlyActivity()),
    'errors.getErrors': each(s => errors.getErrors(s)),
    'files.getSessionFilesWithAttribution': once(() => files.getSessionFilesWithAttribution(ids.session)),
    'observability.readWatcherStatus': once(() => observability.readWatcherStatus()),
    'observability.getOverallHealth': once(() => observability.getOverallHealth(null)),
    'observability.getIngestionStatsAll': once(() => observability.getIngestionStatsAll(null)),
    'observability.getWatcherHealth': once(() => observability.getWatcherHealth(null, null, null)),
    'observability.getRecentWatcherErrors': once(() => observability.getRecentWatcherErrors(50)),
    'observability.getDbtHealth': once(() => observability.getDbtHealth()),
    'observability.getDbtArtifacts': once(() => observability.getDbtArtifacts()),
    'observability.getIngestCoverage': once(() => observability.getIngestCoverage()),
    'observability.getNumberIntegrity': once(() => observability.getNumberIntegrity()),
    'observability.getHourlyIngestion': [() => observability.getHourlyIngestion(24), () => observability.getHourlyIngestion(1000)],
    'observability.getDbtRunHistory': once(() => observability.getDbtRunHistory(6)),
    'observability.getMedallionLayers': once(() => observability.getMedallionLayers([], null)),
    'observability.getPipelineSnapshot': once(() => observability.getPipelineSnapshot()),
    'people.getPeople': each(s => people.getPeople(s)),
    'people.getPerson': once(() => people.getPerson(ids.person)),
    'people.getPersonSessions': each(s => people.getPersonSessions(ids.person, s)),
    'people.getPersonAgents': each(s => people.getPersonAgents(ids.person, s)),
    'people.getPersonApps': each(s => people.getPersonApps(ids.person, s)),
    'people.getPersonPrompts': each(s => people.getPersonPrompts(ids.person, 8, s)),
    'people.getPersonRangeAggregates': each(s => people.getPersonRangeAggregates(ids.person, s)),
    'prompts.getSessionPrompts': once(() => prompts.getSessionPrompts(ids.session)),
    'prompts.getAppPrompts': each(s => prompts.getAppPrompts(ids.app, 6, s)),
    'prompts.getAppAllPrompts': each(s => prompts.getAppAllPrompts(ids.app, 200, s)),
    'prompts.getAgentPrompts': each(s => prompts.getAgentPrompts(ids.agent, 6, s)),
    'prompts.getLoudestPromptOfDay': once(() => prompts.getLoudestPromptOfDay()),
    'sessions.getSessions': [...each(s => sessions.getSessions({}, s)), () => sessions.getSessions(filters, sinces[1])],
    'sessions.getSessionsStats': [...each(s => sessions.getSessionsStats({}, s)), () => sessions.getSessionsStats(filters, sinces[1])],
    // an unknown id also exercises the recent_events fallbacks
    'sessions.getSession': [() => sessions.getSession(ids.session), () => sessions.getSession('no-such-session')],
    'sessions.getSessionTurns': [() => sessions.getSessionTurns(ids.session), () => sessions.getSessionTurns('no-such-session', { all: true })],
    'sessions.getSessionErrors': once(() => sessions.getSessionErrors(ids.session)),
    'sessions.getSessionFiles': once(() => sessions.getSessionFiles(ids.session)),
    'sessions.getSessionToolMix': once(() => sessions.getSessionToolMix(ids.session)),
    'sessions.getSessionGitCommands': once(() => sessions.getSessionGitCommands(ids.session)),
    'sessions.getSessionToolExecutions': once(() => sessions.getSessionToolExecutions(ids.session)),
    'sessions.getSessionPrompts': once(() => sessions.getSessionPrompts(ids.session)),
    'sessions.getSessionPromptHeroes': once(() => sessions.getSessionPromptHeroes(ids.session)),
    'sessions.getSessionThinkingBlocks': once(() => sessions.getSessionThinkingBlocks(ids.session)),
    'sessions.getSessionSkillsUsed': once(() => sessions.getSessionSkillsUsed(ids.session)),
    'sessions.getSessionErrorResolutions': once(() => sessions.getSessionErrorResolutions(ids.session)),
  }
}

export function exportedFunctionNames(): string[] {
  return Object.entries(MODULES).flatMap(([mod, m]) =>
    Object.entries(m).filter(([, v]) => typeof v === 'function').map(([k]) => `${mod}.${k}`))
}
