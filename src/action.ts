import { sep, join } from "path"
import { readFileSync } from "fs"
import { exec } from "@actions/exec"
import * as core from "@actions/core"
import { GitHub, context } from "@actions/github"
import type { Octokit } from "@octokit/rest"
import flatMap from "lodash/flatMap"
import filter from "lodash/filter"
import map from "lodash/map"
import strip from "strip-ansi"
import table from "markdown-table"
import { createCoverageMap, CoverageMapData } from "istanbul-lib-coverage"
import type { FormattedTestResults } from "@jest/test-result/build/types"

const ACTION_NAME = "jest-coverage-comment"
const COVERAGE_HEADER = "**Code coverage**\n\n"
const COVERAGE_HEADER_PREV = "**Previous code coverage**\n\n"
const COVERAGE_FILES_TO_CONSIDER = <any>[]

export async function run() {
  const CWD = process.cwd() + sep
  const RESULTS_FILE = "./jest.results.json"
  const RESULTS_FILE_PREV = "./jest.results.prev.json"

  try {
    const token = process.env.GITHUB_TOKEN
    if (token === undefined) {
      core.error("GITHUB_TOKEN not set.")
      core.setFailed("GITHUB_TOKEN not set.")
      return
    }

    const cmd = getJestCommand(RESULTS_FILE)

    await execJest(cmd)

    // octokit
    const octokit = new GitHub(token)

    // Parse results
    const results = await parseResults(RESULTS_FILE)

    if (results !== "empty") {
      // Get base branch coverage (previous coverage)
      if (context.payload.pull_request?.base.ref) {
        await exec("git checkout origin" + context.payload.pull_request?.base.ref, [], {})

        const cmd = getJestCommandPrev(RESULTS_FILE_PREV)

        await execJest(cmd)

        // Parse prev results
        const prevResults = await parseResults(RESULTS_FILE_PREV)

        // Checks
        const checkPayloadPrev = getCheckPayload(prevResults, CWD)
        const checkPayload = getCheckPayload(results, CWD)
        await octokit.checks.create(checkPayload)
        await octokit.checks.create(checkPayloadPrev)

        // Coverage comments
        if (shouldCommentCoverage()) {
          const comment = getCoverageTable(results, CWD)
          console.debug("FILES TO CONSIDER: %j", COVERAGE_FILES_TO_CONSIDER)
          const commentPrev = getCoverageTable(prevResults, CWD, true)

          if (commentPrev) {
            // await deletePreviousComments(octokit)
            const commentPayload = getCommentPayload(commentPrev)
            await octokit.issues.createComment(commentPayload)
          }

          if (comment) {
            // await deletePreviousComments(octokit)
            const commentPayload = getCommentPayload(comment)
            await octokit.issues.createComment(commentPayload)
          }
        }

        if (!results.success) {
          core.setFailed("Some jest tests failed.")
        }
      } else {
        // Checks
        const checkPayload = getCheckPayload(results, CWD)
        await octokit.checks.create(checkPayload)

        // Coverage comments
        if (shouldCommentCoverage()) {
          const comment = getCoverageTable(results, CWD)
          if (comment) {
            // await deletePreviousComments(octokit)
            const commentPayload = getCommentPayload(comment)
            await octokit.issues.createComment(commentPayload)
          }
        }

        if (!results.success) {
          core.setFailed("Some jest tests failed.")
        }
      }
    }
  } catch (error) {
    console.error(error)
    core.setFailed(error.message)
  }
}

async function deletePreviousComments(octokit: GitHub) {
  const { data } = await octokit.issues.listComments({
    ...context.repo,
    per_page: 100,
    issue_number: getPullId(),
  })
  return Promise.all(
    data
      .filter(
        (c) =>
          c.user.login === "github-actions[bot]" && c.body.startsWith(COVERAGE_HEADER),
      )
      .map((c) => octokit.issues.deleteComment({ ...context.repo, comment_id: c.id })),
  )
}

function shouldCommentCoverage(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-comment", { required: false })))
}

function shouldRunOnlyChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("changes-only", { required: false })))
}

export function getCoverageTable(
  results: FormattedTestResults,
  cwd: string,
  isPrev?: boolean,
): string | false {
  if (!results.coverageMap) {
    return ""
  }
  const covMap = createCoverageMap((results.coverageMap as unknown) as CoverageMapData)
  const rows = [["Filename", "Statements", "Branches", "Functions", "Lines"]]

  if (!Object.keys(covMap.data).length) {
    console.error("No entries found in coverage data")
    return false
  }

  for (const [filename, data] of Object.entries(covMap.data || {})) {
    const { data: summary } = data.toSummary()

    if (!isPrev) {
      COVERAGE_FILES_TO_CONSIDER.push(filename)

      rows.push([
        // filename.replace(cwd, ""),
        filename.substr(filename.lastIndexOf("/") + 1),
        summary.statements.pct + "%",
        summary.branches.pct + "%",
        summary.functions.pct + "%",
        summary.lines.pct + "%",
      ])
    }

    if (isPrev && COVERAGE_FILES_TO_CONSIDER.includes(filename)) {
      rows.push([
        // filename.replace(cwd, ""),
        filename.substr(filename.lastIndexOf("/") + 1),
        summary.statements.pct + "%",
        summary.branches.pct + "%",
        summary.functions.pct + "%",
        summary.lines.pct + "%",
      ])
    }
  }

  return isPrev
    ? COVERAGE_HEADER_PREV + table(rows, { align: ["l", "r", "r", "r", "r"] })
    : COVERAGE_HEADER + table(rows, { align: ["l", "r", "r", "r", "r"] })
}

function getCommentPayload(body: string) {
  const payload: Octokit.IssuesCreateCommentParams = {
    ...context.repo,
    body,
    issue_number: getPullId(),
  }
  return payload
}

function getCheckPayload(results: FormattedTestResults, cwd: string) {
  const payload: Octokit.ChecksCreateParams = {
    ...context.repo,
    head_sha: getSha(),
    name: ACTION_NAME,
    status: "completed",
    conclusion: results.success ? "success" : "failure",
    output: {
      title: results.success ? "Jest tests passed" : "Jest tests failed",
      text: getOutputText(results),
      summary: results.success
        ? `${results.numPassedTests} tests passing in ${
            results.numPassedTestSuites
          } suite${results.numPassedTestSuites > 1 ? "s" : ""}.`
        : `Failed tests: ${results.numFailedTests}/${results.numTotalTests}. Failed suites: ${results.numFailedTests}/${results.numTotalTestSuites}.`,

      annotations: getAnnotations(results, cwd),
    },
  }
  console.debug("Check payload: %j", payload)
  return payload
}

function getJestCommand(resultsFile: string) {
  let cmd = core.getInput("test-command", { required: false })
  const jestOptions = `--json ${shouldCommentCoverage() ? "--coverage" : ""} ${
    context.payload.pull_request?.base.ref
      ? "--changedSince=" + "origin/" + context.payload.pull_request?.base.ref
      : ""
  } --outputFile=${resultsFile}`
  const isNpm = cmd.startsWith("npm") || cmd.startsWith("npx")
  cmd += (isNpm ? " -- " : " ") + jestOptions
  core.debug("Final test command: " + cmd)
  console.debug("Final test command: %j", cmd)
  console.debug("BASE REF: %j", context.payload.pull_request?.base.ref)
  return cmd
}

function getJestCommandPrev(resultsFile: string) {
  let cmd = core.getInput("test-command", { required: false })
  const jestOptions = `--json ${
    shouldCommentCoverage() ? "--coverage" : ""
  } --outputFile=${resultsFile}`
  const isNpm = cmd.startsWith("npm") || cmd.startsWith("npx")
  cmd += (isNpm ? " -- " : " ") + jestOptions
  core.debug("Final test command: " + cmd)
  console.debug("Final test PREV command: %j", cmd)
  console.debug("BASE REF: %j", context.payload.pull_request?.base.ref)
  return cmd
}

function parseResults(resultsFile: string): FormattedTestResults {
  try {
    const results = JSON.parse(readFileSync(resultsFile, "utf-8"))
    console.debug("Jest results: %j", results)
    return results
  } catch (err) {
    console.debug("ERROR trying to read results file: %j", err)
    return "empty"
  }
}

async function execJest(cmd: string) {
  try {
    await exec(cmd, [], {})
    console.debug("Jest command executed")
  } catch (err) {
    console.debug("ERROR trying to run the test command: %j", err)
  }
}

function getPullId(): number {
  return context.payload.pull_request?.number ?? 0
}

function getSha(): string {
  return context.payload.pull_request?.head.sha ?? context.sha
}

const getAnnotations = (
  results: FormattedTestResults,
  cwd: string,
): Octokit.ChecksCreateParamsOutputAnnotations[] => {
  if (results.success) {
    return []
  }
  return flatMap(results.testResults, (result) => {
    return filter(result.assertionResults, ["status", "failed"]).map((assertion) => ({
      path: result.name.replace(cwd, ""),
      start_line: assertion.location?.line ?? 0,
      end_line: assertion.location?.line ?? 0,
      annotation_level: "failure",
      title: assertion.ancestorTitles.concat(assertion.title).join(" > "),
      message: strip(assertion.failureMessages?.join("\n\n") ?? ""),
    }))
  })
}

const getOutputText = (results: FormattedTestResults) => {
  if (results.success) {
    return
  }
  const entries = filter(map(results.testResults, (r) => strip(r.message)))
  return asMarkdownCode(entries.join("\n"))
}

export function asMarkdownCode(str: string) {
  return "```\n" + str.trimRight() + "\n```"
}
