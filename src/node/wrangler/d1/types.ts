export type Database = {
	uuid: string;
	previewDatabaseUuid?: string;
	name?: string;
	binding: string;
	internal_env?: string;
	migrationsTableName: string;
	migrationsFolderPath: string;
};
