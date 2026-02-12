import {HttpRoute} from "../types/route";
import {$Database} from "./$Database";
import {$Env} from './env'

export interface $DBExtension<T extends $Env = $Env>{
    // new<T extends $Env = $Env>(db: $Database<T>, ...rest: any[]): $DBExtension<T>
    getAuthToken?(): Promise<string | undefined>
    setup?(version: number): Promise<void>
    routes: HttpRoute[]
}
