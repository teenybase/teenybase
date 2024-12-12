import {HttpRoute} from "../types/route";
import {$Database} from "./$Database";
import {$Env} from './env'

export abstract class $DBExtension<T extends $Env = $Env> {
    constructor(readonly db: $Database<T>) {
    }

    async getAuthToken?(): Promise<string | undefined>

    setup?(version: number): Promise<void>

    routes: HttpRoute[] = []
}
