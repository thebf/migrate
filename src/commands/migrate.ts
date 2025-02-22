import { CommandModule } from "yargs";

import { executeActions } from "../actions";
import {
  getLastMigration,
  getMigrationsAfter,
  runCommittedMigration,
} from "../migration";
import { withClient } from "../pg";
import { withAdvisoryLock } from "../pgReal";
import { ParsedSettings, parseSettings, Settings } from "../settings";
import { CommonArgv, getSettings } from "./_common";

interface MigrateArgv extends CommonArgv {
  shadow: boolean;
  forceActions: boolean;
}

export async function _migrate(
  parsedSettings: ParsedSettings,
  shadow = false,
  forceActions = false,
): Promise<void> {
  const connectionString = shadow
    ? parsedSettings.shadowConnectionString
    : parsedSettings.connectionString;
  if (!connectionString) {
    throw new Error("Could not determine connection string");
  }
  const logSuffix = shadow ? "[shadow]" : "";
  await withClient(
    connectionString,
    parsedSettings,
    async (pgClient, context) => {
      await withAdvisoryLock(pgClient, async () => {
        const lastMigration = await getLastMigration(pgClient, parsedSettings);
        const remainingMigrations = await getMigrationsAfter(
          parsedSettings,
          lastMigration,
        );
        const shouldExecuteActions =
          remainingMigrations.length > 0 || forceActions;
        if (shouldExecuteActions) {
          await executeActions(
            parsedSettings,
            shadow,
            parsedSettings.beforeAllMigrations,
          );
        }
        // Run migrations in series
        for (const migration of remainingMigrations) {
          await runCommittedMigration(
            pgClient,
            parsedSettings,
            context,
            migration,
            logSuffix,
          );
        }
        if (shouldExecuteActions) {
          await executeActions(
            parsedSettings,
            shadow,
            parsedSettings.afterAllMigrations,
          );
        }
        parsedSettings.logger.info(
          `graphile-migrate${logSuffix}: ${
            remainingMigrations.length > 0
              ? `${remainingMigrations.length} committed migrations executed`
              : lastMigration
              ? "Already up to date"
              : `Up to date — no committed migrations to run`
          }`,
        );
      });
    },
  );
}

export async function migrate(
  settings: Settings,
  shadow = false,
  forceActions = false,
): Promise<void> {
  const parsedSettings = await parseSettings(settings, shadow);
  return _migrate(parsedSettings, shadow, forceActions);
}

export const migrateCommand: CommandModule<never, MigrateArgv> = {
  command: "migrate",
  aliases: [],
  describe:
    "Runs any un-executed committed migrations. Does NOT run the current migration. For use in production and development.",
  builder: {
    shadow: {
      type: "boolean",
      default: false,
      description: "Apply migrations to the shadow DB (for development).",
    },
    forceActions: {
      type: "boolean",
      default: false,
      description:
        "Run beforeAllMigrations and afterAllMigrations actions even if no migration was necessary.",
    },
  },
  handler: async argv => {
    await migrate(
      await getSettings({ configFile: argv.config }),
      argv.shadow,
      argv.forceActions,
    );
  },
};
