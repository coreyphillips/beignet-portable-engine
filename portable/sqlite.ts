import { environment } from './state';
export default class Database {
	constructor(path: string) {
		return environment().databaseFactory(path);
	}
}
