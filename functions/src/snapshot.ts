import * as functions from "firebase-functions";
import { database } from "./database";
import * as github from "./github";
import * as util from "./util";
import { snapshot } from "./types";
import * as config from "./config";

// Config
// TODO: This should be a singleton
const config_json = config.getFunctionsConfig("runtime.config");
const bot_config = new config.BotConfig(config_json);

const gh_client = new github.GithubClient(
  config.getFunctionsConfig("github.token")
);
gh_client.auth();

// Just #pubsubthings
const PubSub = require("@google-cloud/pubsub");
const pubsubClient = new PubSub({
  projectId: process.env.GCLOUD_PROJECT
});

function cleanRepoName(name: string): string {
  let cleanName = name.toLowerCase();
  cleanName = cleanName.replace(".", "_");

  return cleanName;
}

function scrubArray(obj: any[], fieldsToScrub: string[]) {
  return obj.map((item: any) => {
    return scrubObject(item, fieldsToScrub);
  });
}

function scrubObject(obj: any, fieldsToScrub: string[]) {
  Object.keys(obj)
    .filter(key => {
      const isValid = fieldsToScrub.filter(fieldMatch => {
        return key.match(new RegExp(fieldMatch));
      });

      return isValid.length;
    })
    .forEach(key => {
      delete obj[key];
    });

  return obj;
}

function OrgSnapshotPath(org: string) {
  if (org === "firebase") {
    return "/snapshots/github";
  }

  return `/snapshots/${org}`;
}

function DateSnapshotPath(org: string, date: Date) {
  return `${OrgSnapshotPath(org)}/${util.DateSlug(date)}`;
}

function RepoSnapshotPath(org: string, repo: string, date: Date) {
  return `${DateSnapshotPath(org, date)}/repos/${repo}`;
}

/**
 * Get a point-in-time snapshot of a GitHub org.
 *
 * Must be followed up by a job to snap each repo.
 */
export async function GetOrganizationSnapshot(org: string, deep: boolean) {
  // Get basic data about the org
  const orgRes = await gh_client.getOrg(org);
  const orgData = scrubObject(orgRes.data, ["owner", "organization", "url"]);

  // For shallow snapshots, don't retrieve all of the repos
  if (!deep) {
    return orgData;
  }

  // Fill in repos data
  const repos: { [s: string]: any } = {};
  let reposData: any[] = await gh_client.getReposInOrg(org);
  reposData = scrubArray(reposData, ["owner", "organization", "url"]);

  for (const key in reposData) {
    const repoData = reposData[key];
    const cleanName = cleanRepoName(repoData.name);
    repos[cleanName] = repoData;
  }

  orgData.repos = repos;
  return orgData;
}

/**
 * Get a point-in-time snapshot for a Github repo.
 *
 * repoData is the base data retrieved by GetOrganizationSnapshot.
 * Yes, I know this is ugly.
 */
export async function GetRepoSnapshot(
  owner: string,
  repo: string,
  repoData: any
) {
  if (!repoData) {
    console.warn(`GetRepoSnapshot called with null data for ${owner}/${repo}`);
  }

  repoData.closed_issues_count = 0;
  repoData.closed_pull_requests_count = 0;

  const keyed_issues: { [s: string]: any } = {};
  let issuesData = await gh_client.getIssuesForRepo(owner, repo);

  issuesData = scrubArray(issuesData, ["organization", "url"]);

  issuesData.forEach((issue: any) => {
    issue.user = scrubObject(issue.user, ["url"]);
    issue.pull_request = !!issue.pull_request;

    if (issue.state !== "open") {
      if (!issue.pull_request) {
        repoData.closed_issues_count += 1;
      } else {
        repoData.closed_pull_requests_count += 1;
      }
    } else {
      keyed_issues["id_" + issue.number] = issue;
    }
  });

  repoData.issues = keyed_issues;

  return repoData;
}

/**
 * Get the snapshot for a repo on a specific Date.
 */
export async function FetchRepoSnapshot(
  org: string,
  repo: string,
  date: Date
): Promise<snapshot.Repo | undefined> {
  const path = RepoSnapshotPath(org, repo, date);
  const snap = await database.ref(path).once("value");
  const data = snap.val();
  return data;
}

export const SaveRepoSnapshot = functions
  .runWith(util.FUNCTION_OPTS)
  .pubsub.topic("repo_snapshot")
  .onPublish(async event => {
    // TODO: Enable retry, using retry best practices
    const data = event.json;
    const org = data.org;

    const repoName = data.repo;
    const repoKey = cleanRepoName(repoName);

    if (!(org && repoName)) {
      console.log(
        `PubSub message must include 'org' and 'repo': ${event.data}`
      );
    }

    console.log(`SaveRepoSnapshot(${org}/${repoName})`);
    const orgRef = database.ref(DateSnapshotPath(org, new Date()));
    const repoSnapRef = orgRef.child("repos").child(repoKey);

    // Get the "base" data that was retriebed during the org snapshot
    let baseRepoData = (await repoSnapRef.once("value")).val();
    if (!baseRepoData) {
      console.log(
        `Couldn't get base repo data for ${org}/${repoName}, getting from GitHub`
      );

      // Get the repo data from GitHub API directly
      const repoData = await gh_client.getRepo(org, repoName);
      const cleanRepoData = scrubObject(repoData, [
        "owner",
        "organization",
        "url"
      ]);

      repoSnapRef.set(cleanRepoData);
      baseRepoData = cleanRepoData;
    }

    // Store the repo snapshot under the proper path
    util.startTimer("GetRepoSnapshot");
    const fullRepoData = await GetRepoSnapshot(org, repoName, baseRepoData);
    util.endTimer("GetRepoSnapshot");

    console.log(`Saving repo snapshot to ${repoSnapRef.path}`);
    await repoSnapRef.set(fullRepoData);

    // Store non-date-specific repo metadata
    // TODO: This should probably be broken out into a function like GetRepoSnapshot
    //       and then only saved/timed here.
    const repoMetaRef = database
      .ref("repo-metadata")
      .child(org)
      .child(repoKey);

    // Store collaborators as a map of name --> true
    try {
      const collabNames = await gh_client.getCollaboratorsForRepo(
        org,
        repoName
      );
      const collabMap: { [s: string]: boolean } = {};
      collabNames.forEach((name: string) => {
        collabMap[name] = true;
      });

      await repoMetaRef.child("collaborators").set(collabMap);
    } catch (e) {
      console.warn(
        `Failed to get collaborators for repo ${org}/${repoName}`,
        e
      );
    }
  });

export const SaveOrganizationSnapshot = functions
  .runWith(util.FUNCTION_OPTS)
  .pubsub.topic("cleanup")
  .onPublish(async event => {
    const configRepos = bot_config.getAllRepos();

    // Gather all the unique orgs from the configured repos
    const configOrgs: string[] = [];
    for (const r of configRepos) {
      if (configOrgs.indexOf(r.org) < 0 && r.org !== "samtstern") {
        configOrgs.push(r.org);
      }
    }

    // First snapshot the Fireabse org (deep snapshot)
    const firebaseOrgSnap = await GetOrganizationSnapshot("firebase", true);
    await database
      .ref(DateSnapshotPath("firebase", new Date()))
      .set(firebaseOrgSnap);

    // Next take a shallow snapshot of all other orgs
    for (const org of configOrgs) {
      if (org !== "firebase") {
        console.log(`Taking snapshot of org: ${org}`);
        const orgSnap = await GetOrganizationSnapshot(org, false);
        await database.ref(DateSnapshotPath(org, new Date())).set(orgSnap);
      }
    }

    // Build a list of all repos to snapshot, across orgs
    const reposToSnapshot: OrgRepo[] = [];

    // All Firebase orgs are automatically included
    const firebaseRepoKeys = Object.keys(firebaseOrgSnap.repos);
    for (const repoKey of firebaseRepoKeys) {
      const repoName = firebaseOrgSnap.repos[repoKey].name;
      reposToSnapshot.push({
        org: "firebase",
        repo: repoName
      });
    }

    // Push in all non-Firebase repos that are present in the config
    for (const r of configRepos) {
      if (r.org !== "firebase") {
        reposToSnapshot.push({
          org: r.org,
          repo: r.name
        });
      }
    }

    // Fan out for each repo via PubSub, adding a 1s delay in
    // between to avoid spamming the function.
    for (const r of reposToSnapshot) {
      util.delay(1.0);
      await sendPubSub("repo_snapshot", r);
    }
  });

interface OrgRepo {
  org: string;
  repo: string;
}

function sendPubSub(topic: string, data: any): Promise<any> {
  const publisher = pubsubClient.topic(topic).publisher();

  console.log(`PubSub(${topic}, ${JSON.stringify(data)}`);
  return publisher.publish(Buffer.from(JSON.stringify(data)));
}
