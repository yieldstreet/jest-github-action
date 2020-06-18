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
const COVERAGE_FILES_TO_CONSIDER = <any>[]
let coverageHeader: any
let coverageHeaderPrev: any
let filesAffectedMinor = <any>[]
let filesAffectedHigher = <any>[]

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

    const baseBranch = context.payload.pull_request?.base.ref
    const currentBranch = context.payload.pull_request?.head.ref

    const modifiedFiles = await exec("git diff --name-only " + currentBranch + " $(git merge-base " + currentBranch + " " + baseBranch + " )", [], {})
    console.debug("============ modifiedFiles: %j", modifiedFiles)

    const cmd = getJestCommand(RESULTS_FILE)

    await execJest(cmd)

    // octokit
    const octokit = new GitHub(token)

    // Parse results
    const results = await parseResults(RESULTS_FILE)
    console.debug("============ results parsed: %j", modifiedFiles)

    if (results !== "empty") {
      coverageHeader = "\n\n**" + currentBranch + " coverage**\n\n"

      // Get base branch coverage (previous coverage)
      if (baseBranch) {
        await exec("git checkout origin/" + baseBranch, [], {})

        coverageHeaderPrev = "**" + baseBranch + " coverage**\n\n"

        const cmd = getJestCommandPrev(RESULTS_FILE_PREV)

        await execJest(cmd)

        // Parse prev results
        const prevResults = await parseResults(RESULTS_FILE_PREV)

        const comment = getCoverageTable(results, CWD)

        // Checks
        // const checkPayloadPrev = getCheckPayload(prevResults, CWD)
        // const checkPayload = getCheckPayload(results, CWD)
        // await octokit.checks.create(checkPayload)
        // await octokit.checks.create(checkPayloadPrev)

        // Coverage comments
        if (comment) {
          let commentPayload: any
          let commentPayloadNew: any
          let commentPayloadPrev: any
          let diffMessage: any
          let coverageArrayPrev: any = []
          let coverageArrayNew: any = []
          let commentPrev: any
          let coverageDiff: any

          console.debug("============ prevResults: %j", prevResults)

          if (prevResults !== "empty") {
            commentPrev = getCoverageTable(prevResults, CWD, true)
          }

          console.debug("============ pased empty check")

          console.debug("============ comment: %j", comment)

          if (comment) {
            // await deletePreviousComments(octokit)
            commentPayloadNew = getCommentPayload(comment)
            commentPayload = commentPayloadNew

            const coverageNumbersNew = commentPayloadNew.body
              .match(/(\d|\d\.\d)+%\s(?=\|$)/gm)
              .map((coverageNumberNew: any) =>
                parseFloat(coverageNumberNew.trim().replace("%", "")),
              )
            const coverageNamesNew = commentPayloadNew.body
              .match(/\/\w+\/\w+\.js(?=\s+\|\s+(\d|\d\.\d)+%\s\|$)/gm)
              .map((coverageName: any) => coverageName.replace(".js", ""))

            coverageNamesNew.forEach((coverageName: any, idx: any) =>
              coverageArrayNew.push({
                component: coverageName,
                percent: coverageNumbersNew[idx],
              }),
            )
          }

          console.debug("============ pased comment check")

          console.debug("============ commentPrev: %j", commentPrev)

          if (commentPrev) {
            // await deletePreviousComments(octokit)
            commentPayloadPrev = getCommentPayload(commentPrev)

            const coverageNumbersPrev = commentPayloadPrev.body
              .match(/(\d|\d\.\d)+%\s(?=\|$)/gm)
              .map((coverageNumber: any) =>
                parseFloat(coverageNumber.trim().replace("%", "")),
              )
            const coverageNamesPrev = commentPayloadPrev.body
              .match(/\/\w+\/\w+\.js(?=\s+\|\s+(\d|\d\.\d)+%\s\|$)/gm)
              .map((coverageName: any) => coverageName.replace(".js", ""))

            coverageNamesPrev.forEach((coverageName: any, idx: any) =>
              coverageArrayPrev.push({
                component: coverageName,
                percent: coverageNumbersPrev[idx],
              }),
            )
          }

          console.debug("============ pased commentPrev check")

          console.debug(
            "============ coverageArrayNew.length: %j",
            coverageArrayNew.length,
          )
          console.debug(
            "============ coverageArrayPrev.length: %j",
            coverageArrayPrev.length,
          )
          console.debug("============ coverageArrayNew: %j", coverageArrayNew)
          console.debug("============ coverageArrayPrev: %j", coverageArrayPrev)

          // Match arrays order based on the new array
          if (coverageArrayNew.length > 0 && coverageArrayPrev.length > 0) {
            coverageArrayPrev = coverageArrayNew.map((coverageItem: any) => ({
              component: coverageItem.component,
              percent: coverageArrayPrev.find(
                (prevItem: any) => prevItem.component === coverageItem.component,
              ).percent,
            }))
          }

          console.debug("============ pased arrays check")

          if (coverageArrayNew.length > 0 && coverageArrayPrev.length > 0) {
            coverageDiff = getCoverageDiff(coverageArrayPrev, coverageArrayNew)
          }

          console.debug("============ pased diff function")

          console.debug("============ coverageDiff: %j", coverageDiff)

          if (coverageDiff) {
            switch (coverageDiff) {
              case "minor":
                diffMessage =
                  "```diff\n- Your PR decrease the code coverage of one or more files.\n```\n\n" +
                  "**Improve tests for:**\n\n" +
                  `${filesAffectedMinor.map(
                    (fileAffected: any) => " `" + fileAffected + "`",
                  )}` +
                  "\n\n"
                break
              case "higher":
                diffMessage =
                  "```diff\n+ Your PR increase the code coverage!\n```\n\n" +
                  "**Directly affected files:**\n\n" +
                  `${filesAffectedHigher.map(
                    (fileAffected: any) => " `" + fileAffected + "`",
                  )}` +
                  "\n\n"
                break
              default:
                diffMessage =
                  "```diff\n! Your PR does not increase nor decrease the code coverage.\n```\n\n"
                break
            }

            commentPayload.body =
              diffMessage + commentPayloadPrev.body + commentPayloadNew.body
          } else if (comment) {
            diffMessage = "```diff\n+ Your PR increase the code coverage!\n```\n\n"

            commentPayload.body = diffMessage + commentPayloadNew.body
          }

          if (comment) {
            await octokit.issues.createComment(commentPayload)
          }

          if (coverageDiff === "minor") {
            core.setFailed(
              "Your PR decrease the code coverage of one or more files. Please add additional tests",
            )
          }
        }

        if (!results.success) {
          // core.setFailed("Some jest tests failed.")
        }
      } else {
        // Checks
        // const checkPayload = getCheckPayload(results, CWD)
        // await octokit.checks.create(checkPayload)

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
          //core.setFailed("Some jest tests failed.")
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
          c.user.login === "github-actions[bot]" && c.body.startsWith(coverageHeader),
      )
      .map((c) => octokit.issues.deleteComment({ ...context.repo, comment_id: c.id })),
  )
}

function getCoverageDiff(
  coverageArrayPrev: any,
  coverageArrayNew: any,
): string | undefined {
  const coveragePercentagesPrev = coverageArrayPrev.map((item: any) => item.percent)
  const coveragePercentagesNew = coverageArrayNew.map((item: any) => item.percent)

  const isEqual = coveragePercentagesNew.toString() === coveragePercentagesPrev.toString()
  let isMinor = false
  let isHigher = false

  coveragePercentagesNew.forEach((coverageNumberNew: any, idx: any) => {
    if (coverageNumberNew < coveragePercentagesPrev[idx]) {
      filesAffectedMinor.push(coverageArrayNew[idx].component + ".js")
      isMinor = true
    } else if (coverageNumberNew > coveragePercentagesPrev[idx]) {
      filesAffectedHigher.push(coverageArrayNew[idx].component + ".js")
      isHigher = true
    }
  })

  if (isEqual) {
    return "equal"
  }

  if (isMinor) {
    return "minor"
  } else if (isHigher) {
    return "higher"
  }
}

function shouldCommentCoverage(): boolean {
  return Boolean(JSON.parse(core.getInput("coverage-comment", { required: false })))
}

function shouldRunOnlyChangedFiles(): boolean {
  return Boolean(JSON.parse(core.getInput("changes-only", { required: false })))
}

export function getCoverageTable(
  results: any,
  cwd: string,
  isPrev?: boolean,
): string | false {
  if (!results.coverageMap) {
    return ""
  }
  const covMap = createCoverageMap((results.coverageMap as unknown) as CoverageMapData)
  const rows = [["Filename", "Functions Cover Rate"]]

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
        // filename.substr(filename.lastIndexOf("/") + 1),
        filename.match(/\/\w+\/\w+\.js(?=$)/gm)[0],
        summary.functions.pct + "%",
      ])
    }

    if (isPrev && COVERAGE_FILES_TO_CONSIDER.includes(filename)) {
      rows.push([
        // filename.replace(cwd, ""),
        // filename.substr(filename.lastIndexOf("/") + 1),
        filename.match(/\/\w+\/\w+\.js(?=$)/gm)[0],
        summary.functions.pct + "%",
      ])
    }
  }

  return isPrev
    ? coverageHeaderPrev + table(rows, { align: ["l", "r"] })
    : coverageHeader + table(rows, { align: ["l", "r"] })
}

function getCommentPayload(body: any) {
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
