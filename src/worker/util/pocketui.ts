import {z} from 'zod'
import {$Database} from '../$Database'
import {HttpRoute, HttpRouteZod} from '../../types/route'
import {$DBExtension} from '../$DBExtension'
import {deleteCookie, getSignedCookie, setCookie, setSignedCookie} from 'hono/cookie'
import {ContentfulStatusCode, StatusCode} from 'hono/utils/http-status'
import {decode} from '@tsndr/cloudflare-worker-jwt'
import {$Env} from '../env'

const cookieName = 'teeny-pocket-ui-access-token'
const cookieNameRec = 'teeny-pocket-ui-user-data'

export type PocketUiEnv = $Env & {
    Bindings: $Env['Bindings'] & {
        POCKET_UI_VIEWER_PASSWORD?: string;
        POCKET_UI_EDITOR_PASSWORD?: string;
    },
    // Variables: $Env['Variables']
}

export class PocketUIExtension<T extends PocketUiEnv = PocketUiEnv> implements $DBExtension<T> {

    async getAuthToken(): Promise<string | undefined> {
        return (await getSignedCookie(this.db.c, this.db.c.env.ADMIN_SERVICE_TOKEN || 'admin', cookieName)) || undefined
    }

    // private async _initAuth(){
    //     const tok= await this._getAuthToken()
    //     if(tok) return this.db.initAuth(tok)
    // }

    uiVersion = 'latest'
    baseUrl = 'https://cdn.jsdelivr.net/npm/@teenybase/pocket-ui@POCKET_UI_VERSION/dist/'
    // baseUrl = 'http://localhost:4173/'

    routes: HttpRoute[] = []

    constructor(private readonly db: $Database<T>, baseUrl?: string, uiVersion?: string) {
        if(baseUrl) this.baseUrl = baseUrl
        if(uiVersion) this.uiVersion = uiVersion
        this.routes.push({
            path: '/pocket/logout',
            method: 'get',
            handler: {
                raw: async () => {
                    // await this._initAuth()
                    deleteCookie(this.db.c, cookieName)
                    deleteCookie(this.db.c, cookieNameRec)
                    return this.db.c.redirect('./')
                }
            },
            zod: () => (<HttpRouteZod>{
                description: 'Logout of Pocket UI',
                request: {},
                responses: {
                    '302': {
                        description: 'Redirect to login',
                    }
                },
            })
        })
        this.routes.push({
            path: '/pocket/login',
            method: 'get',
            handler: {
                raw: async () => {
                    // await this._initAuth()
                    if (this.db.auth.uid) return this.db.c.redirect('./')
                    const iframe = this.db.c.req.query('iframe') !== undefined
                    return this.loginPage(undefined, 200, iframe)
                }
            },
            zod: () => (<HttpRouteZod>{
                description: 'Login for Pocket UI',
                request: {},
                responses: {
                    '200': {
                        description: 'Success',
                        content: {
                            'text/html': {
                                schema: z.string(),
                            }
                        },
                    }
                },
            })
        })
        this.routes.push({
            // login as viewer/editor/superadmin,
            // user should pass POCKET_UI_VIEWER_PASSWORD, POCKET_UI_EDITOR_PASSWORD, or ADMIN_SERVICE_TOKEN
            path: '/pocket/login',
            method: 'post',
            handler: {
                raw: async () => {
                    const iframe = this.db.c.req.query('iframe') !== undefined

                    // await this._initAuth()
                    if (this.db.auth.uid) return this.db.c.redirect('./')
                    let {username, password} = (await this.db.getRequestBody()) ?? {}
                    if (!password) return this.loginPage('Password required', 400, iframe)

                    if(username === 'viewer' && password === this.db.c.env['POCKET_UI_VIEWER_PASSWORD'])
                        password = this.db.c.env['ADMIN_SERVICE_TOKEN']
                    if(username === 'editor' && password === this.db.c.env['POCKET_UI_EDITOR_PASSWORD'])
                        password = this.db.c.env['ADMIN_SERVICE_TOKEN']

                    let err = 'Invalid password'

                    let token = null
                    try {
                        await this.db.initAuth(password)
                        token = await this.db.generateAdminToken(username || 'viewer')
                    }catch (e: any){
                        if (this.db.c.env.RESPOND_WITH_ERRORS && e?.message) err = 'Unable to login - ' + e.message
                        token = null
                    }
                    if (!token) return this.loginPage(err, 400, iframe)

                    const data: any = decode(token).payload
                    data.email = data.sub
                    await setSignedCookie(this.db.c, cookieName, token, this.db.c.env.ADMIN_SERVICE_TOKEN || 'admin', {
                        httpOnly: true,
                        secure: this.db.c.req.raw.url.startsWith('https://'),
                        sameSite: 'Strict',
                        maxAge: 60 * 60
                    })
                    setCookie(this.db.c, cookieNameRec, btoa(JSON.stringify(data)), {
                        httpOnly: false,
                        secure: this.db.c.req.raw.url.startsWith('https://'),
                        sameSite: 'Strict',
                        maxAge: 60 * 60
                    })
                    return this.db.c.redirect('./')
                }
            },
            zod: () => (<HttpRouteZod>{
                description: 'Login for Pocket UI',
                request: {
                    body: {
                        description: 'Login as admin with role viewer/editor/superadmin',
                        content: {
                            'application/json': {
                                schema: z.object({
                                    username: z.string().min(1).max(255).default('viewer').describe('Role for logging in'),
                                    password: z.string().min(1).max(255).describe('POCKET_UI_VIEWER_PASSWORD, POCKET_UI_EDITOR_PASSWORD, or ADMIN_SERVICE_TOKEN'),
                                }),
                            },
                        },
                        required: true,
                    }
                },
                responses: {
                    '302': {description: 'Login success'},
                    '400': {
                        description: 'Invalid password/Bad request',
                        content: {
                            'text/html': {
                                schema: z.string(),
                            }
                        },
                    }
                }
            })
        })
        this.routes.push({
            path: '/pocket/*',
            method: 'get',
            handler: {
                raw: async (_params, path) => {
                    // await this._initAuth()
                    // if(!this.db.auth.uid) return this.db.c.redirect('login') // this is done in frontend.
                    const base = (this.baseUrl||'').replace(/POCKET_UI_VERSION/g, this.uiVersion)
                    path = path.replace('/pocket/', '').replace('/pocket', '') || 'index.html'
                    const res = await fetch(base + path)
                    if (path.endsWith('.html')) {
                        const html = await res.text()
                        // todo can add custom data/scripts here like cookieNameRec
                        return this.db.c.html(html)
                    }
                    return res
                }
            },
            zod: () => (<HttpRouteZod>{
                description: 'Pocket UI for teenybase',
                request: {},
                responses: {
                    '302': {description: 'Not logged in'},
                    '200': {
                        description: 'UI',
                        content: {
                            'text/html': {
                                schema: z.string(),
                            }
                        },
                    }
                }
            })
        })
    }

    // minimal login page, but a proper one is used in pocket-ui
    private loginPage = (msg?: string, code: ContentfulStatusCode = 200, iframe = false) => {
        const loginEndpoint = 'login' + (iframe ? '?iframe' : '')

        return this.db.c.html(`
      <!DOCTYPE html>
        <html lang="en" data-theme="light">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css"/>
          <title>Login</title>
        </head>
        <body style="margin: 3rem;">
        <article style="max-width: 600px; margin: auto; padding: 30px;">
              <h1>Pocket UI Login</h1>
              ${msg ? `<p style="color:red">${msg}</p>` : ''}
          <form id="loginForm" action="${loginEndpoint}" method="post" style="display: flex; flex-direction: column; gap: 10px;">
              <input type="text" id="username" name="username" value="viewer" required>
              <input type="password" id="password" name="password" placeholder="ADMIN_SERVICE_TOKEN" required autofocus>
              <button class="contrast" type="submit">Login</button>
          </form>
          </article>
        </body>
      ${iframe ? `<script>
    window && window.addEventListener('message', (event) => {
      // if (event.origin !== window.location.origin) return;
      const {username, password} = event.data || {};
      if (username && password) {
        document.getElementById('username').value = username;
        document.getElementById('password').value = password;
        document.getElementById('loginForm').submit();
      }
    });
    </script>` : ''}
        </html>
      `, code)
    }

}
