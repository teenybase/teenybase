import {describe, expect, test} from 'vitest'
import {baseLayout1} from '../../src/worker/email/templates/base-layout-1'
import {messageLayout1} from '../../src/worker/email/templates/message-layout-1'
import {actionLinkTemplate} from '../../src/worker/email/templates/action-link'
import {actionTextTemplate} from '../../src/worker/email/templates/action-text'
import {baseLayout1Text} from '../../src/worker/email/templates/base-layout-1.text'
import {messageLayout1Text} from '../../src/worker/email/templates/message-layout-1.text'
import {actionLinkTextTemplate} from '../../src/worker/email/templates/action-link.text'
import {actionTextTextTemplate} from '../../src/worker/email/templates/action-text.text'
import {buildEmailTemplate} from '../../src/worker/email/send-email'
import {replaceTemplateVariables} from '../../src/worker/util/replaceTemplateVariables'

const actionLink = [baseLayout1, messageLayout1, actionLinkTemplate]
const actionText = [baseLayout1, messageLayout1, actionTextTemplate]
const actionLinkText = [baseLayout1Text, messageLayout1Text, actionLinkTextTemplate]
const actionTextText = [baseLayout1Text, messageLayout1Text, actionTextTextTemplate]

const f = (s: any)=>{
    const r = buildEmailTemplate(s)
    // console.log(r)
    return r
}
const f2 = (s: any, v: any)=>{
    const r = buildEmailTemplate(s)
    const r2 = replaceTemplateVariables(r, v, 3)
    // console.log(r2)
    return r2
}
describe('buildEmailTemplate', () => {
    test('actionLink', ()=> expect(f(actionLink).replace(/\s+/g, '')).toBe(actionLinkRes.replace(/\s+/g, '')))
    test('actionText', ()=> expect(f(actionText).replace(/\s+/g, '')).toBe(actionTextRes.replace(/\s+/g, '')))
    test('actionLinkVars', ()=> expect(f2(actionLink, {
        message_title: 'Email Verification',
        message_description: 'Welcome to {{APP_NAME}}. Click the button below to verify your email address.',
        message_footer: 'If the button does not work, copy and paste the following link into your browser - {{action_link}}',
        action_text: 'Verify Email',
        action_link: '{{APP_URL}}verify-email/{{TOKEN}}',
        company_name: "Teenybase",
        company_copyright: "Teenybase, 2024",
        company_address: "Teenybase, 123 Teeny St, Tiny Town, TT 12345",
        support_email: "contact@teenybase.com",
        company_url: "https://teenybase.com",
        APP_URL: "https://app.teenybase.com/",
        TOKEN: "1234567890abcdef",
        APP_NAME: "Teenybase",
    }).replace(/\s+/g, '')).toBe(actionLink2Res.replace(/\s+/g, '')))
    // Text templates: exact-match (no whitespace collapse) — whitespace IS the rendered structure for plain text.
    test('actionLinkText', () => expect(f(actionLinkText)).toBe(actionLinkTextRes))
    test('actionTextText', () => expect(f(actionTextText)).toBe(actionTextTextRes))
})

const actionLinkTextRes = `{{company_name}}
{{company_url}}

{{message_title}}

{{message_description}}

{{action_text | Click here}}: {{action_link}}

{{message_footer}}

—
Problems or questions? {{support_email}}
{{company_name}} • {{company_address}}
© {{company_copyright | Copyright}}
`

const actionTextTextRes = `{{company_name}}
{{company_url}}

{{message_title}}

{{message_description}}

{{action_text}}

{{message_footer}}

—
Problems or questions? {{support_email}}
{{company_name}} • {{company_address}}
© {{company_copyright | Copyright}}
`


const actionLinkRes = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
        "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"
>
<head>
    <title>{{company_name}}</title>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0 "/>
    <meta name="format-detection" content="telephone=no"/>
    <style type="text/css">
        body {
            margin: 0;
            padding: 0;
            -webkit-text-size-adjust: 100% !important;
            -ms-text-size-adjust: 100% !important;
            -webkit-font-smoothing: antialiased !important;
            background-color: #F0F2F8;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif;
        }

        img {
            border: 0 !important;
            outline: none !important;
        }

        p {
            Margin: 0px !important;
            Padding: 0px !important;
        }

        table {
            border-collapse: collapse;
            mso-table-lspace: 0px;
            mso-table-rspace: 0px;
        }

        td, a, span {
            border-collapse: collapse;
            mso-line-height-rule: exactly;
        }

        .ExternalClass * {
            line-height: 100%;
        }

        .em_blue a {
            text-decoration: none;
            color: #264780;
        }

        .em_grey a {
            text-decoration: none;
            color: #434343;
        }

        .em_white a {
            text-decoration: none;
            color: #ffffff;
        }

        .em_aside5 {
            padding: 0 20px !important;
        }

        @media only screen and (min-width: 481px) and (max-width: 649px) {
            .em_main_table {
                width: 100% !important;
            }

            .em_wrapper {
                width: 100% !important;
            }

            .em_hide {
                display: none !important;
            }

            .em_aside10 {
                padding: 0px 10px !important;
            }

            .em_h20 {
                height: 20px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_h10 {
                height: 10px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_aside5 {
                padding: 0px 10px !important;
            }
        }

        @media only screen and (min-width: 375px) and (max-width: 480px) {
            .em_main_table {
                width: 100% !important;
            }

            .em_wrapper {
                width: 100% !important;
            }

            .em_hide {
                display: none !important;
            }

            .em_aside10 {
                padding: 0px 10px !important;
            }

            .em_aside5 {
                padding: 0px 8px !important;
            }

            .em_h20 {
                height: 20px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_h10 {
                height: 10px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_font_11 {
                font-size: 12px !important;
            }

            .em_font_22 {
                font-size: 22px !important;
                line-height: 25px !important;
            }

            .em_w5 {
                width: 7px !important;
            }

            u + .em_body .em_full_wrap {
                width: 100% !important;
                width: 100vw !important;
            }
        }

        @media only screen and (max-width: 374px) {
            .em_main_table {
                width: 100% !important;
            }

            .em_wrapper {
                width: 100% !important;
            }

            .em_hide {
                display: none !important;
            }

            .em_aside10 {
                padding: 0px 10px !important;
            }

            .em_aside5 {
                padding: 0px 8px !important;
            }

            .em_h20 {
                height: 20px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_h10 {
                height: 10px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_font_11 {
                font-size: 11px !important;
            }

            .em_font_22 {
                font-size: 22px !important;
                line-height: 25px !important;
            }

            .em_w5 {
                width: 5px !important;
            }

            u + .em_body .em_full_wrap {
                width: 100% !important;
                width: 100vw !important;
            }
        }
    </style>
</head>
<body class="em_body" style="margin:0px auto; padding:0px;" bgcolor="#F0F2F8">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
    <tr>
        <td align="center" valign="top">
            <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
                   style="width:480px; min-width:480px; max-width:480px;">
                <tr>
                    <td align="left" valign="top" style="padding:0 ;" class="em_aside10">
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" align="left">
                            <tr>
                                <td height="58" style="height:58px;" class="em_h20">&nbsp;</td>
                            </tr>
                            <tr>
                                <td align="left" valign="top">
                                    <a href="{{company_url}}" target="_blank" style="text-decoration:none;">
                                        <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size:20px; line-height:24px; color:rgb(0,0,0); font-weight:500;">{{company_name}}</span>
                                    </a>
                                </td>
                            </tr>
                            <tr>
                                <td height="32" style="height:32px;" class="em_h20">&nbsp;</td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
    <tr>
        <td align="center" valign="top" class="em_aside5">
            <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
                   style="width:480px; min-width:480px; max-width:480px;">
                <tr>
                    <td align="center" valign="top"
                        style="padding:0 20px; background-color:#ffffff; border-radius:12px;">

<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
    <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
    </tr>
    <tr>
        <td class="em_blue em_font_22" align="left" valign="top"
            style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 20px; line-height: 28px; color:#303030; font-weight:600;">
            {{message_title}}
        </td>
    </tr>
    <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
    </tr>
    <tr>
        <td class="em_grey" align="left" valign="top"
            style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 14px; line-height: 20px; color:#4d4d4d;">
            {{message_description}}
        </td>
    </tr>
    <tr>
        <td align="center" valign="top" style="padding: 20px 0;">

<a href="{{action_link}}" target="_blank" style="text-decoration:none;">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
        <tr>
            <td align="center" valign="middle"
                style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 16px; color:{{action_text_color | #ffffff}}; font-weight:500; height:44px; background-color:{{action_button_color | #0074d4}}; border-radius:6px;">
                {{action_text | Click Here}}
            </td>
        </tr>
    </table>
</a>
<table width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr><td height="10" style="height:10px; font-size:0px; line-height:0px;">&nbsp;</td></tr>
    <tr>
        <td align="left" style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 12px; line-height: 18px; color: #666666; word-break: break-all;">
            If the button above doesn't work, copy and paste this link into your browser:<br/>
            <a href="{{action_link}}" style="color: #0074d4; text-decoration: underline;">{{action_link}}</a>
        </td>
    </tr>
</table>

        </td>
    </tr>
    <tr>
        <td class="em_grey" align="left" valign="top"
            style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 14px; line-height: 20px; color:#4d4d4d;">
            {{message_footer}}
        </td>
    </tr>
    <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
    </tr>
</table>

                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
    <tr>
        <td align="center" valign="top">
            <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
                   style="width:480px; min-width:480px; max-width:480px;">
                <tr>
                    <td align="center" valign="top" style="padding:0 20px;" class="em_aside10">
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
                            <tr>
                                <td height="32" style="height:32px;" class="em_h20">&nbsp;</td>
                            </tr>
                            <tr>
                                <td class="em_grey" align="center" valign="top"
                                    style="font-family: Arial, sans-serif; font-size: 15px; line-height: 18px; color:#434343; font-weight:bold;">
                                    Problems or questions?
                                </td>
                            </tr>
                            <tr>
                                <td height="10" style="height:10px; font-size:1px; line-height:1px;">&nbsp;</td>
                            </tr>
                            <tr>
                                <td align="center" valign="top" style="font-size:0px; line-height:0px;">
                                    <table border="0" cellspacing="0" cellpadding="0" align="center">
                                        <tr>
                                            <td class="em_grey em_font_11" align="left" valign="middle"
                                                style="font-family: Arial, sans-serif; font-size: 13px; line-height: 15px; color:#434343;">
                                                <a href="mailto:{{support_email}}"
                                                   style="text-decoration:none; color:#434343;">{{support_email}}</a>
                                                <a href="mailto:{{support_email}}"
                                                   style="text-decoration:none; color:#434343;">[mailto:{{support_email}}]</a>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td height="9" style="font-size:0px; line-height:0px; height:9px;" class="em_h10">
                                </td>
                            </tr>
                            <tr>
                                <td align="center" valign="top">
                                    <table border="0" cellspacing="0" cellpadding="0" align="center">
                                        <tr>
                                            <td width="12" align="left" valign="middle"
                                                style="font-size:0px; line-height:0px; width:12px;">
                                                <!--                                                <a href="#" target="_blank" style="text-decoration:none;"></a>-->
                                            </td>
                                            <td width="7" style="width:7px; font-size:0px; line-height:0px;"
                                                class="em_w5">&nbsp;
                                            </td>
                                            <td class="em_grey em_font_11" align="left" valign="middle"
                                                style="font-family: Arial, sans-serif; font-size: 13px; line-height: 15px; color:#434343;">
                                                <a href="{{company_url}}" target="_blank"
                                                   style="text-decoration:none; color:#434343;">{{company_name}}</a>
                                                &bull; {{company_address}}
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td height="35" style="height:35px;" class="em_h20">&nbsp;</td>
                            </tr>
                        </table>
                    </td>
                </tr>
                <tr>
                    <td height="1" bgcolor="#dadada" style="font-size:0px; line-height:0px; height:1px;">
                    </td>
                </tr>
                <tr>
                    <td align="center" valign="top" style="padding:0 20px;" class="em_aside10">
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
                            <tr>
                                <td height="16" style="font-size:0px; line-height:0px; height:16px;">&nbsp;</td>
                            </tr>
                            <tr>
                                <td align="center" valign="top">
                                    <table border="0" cellspacing="0" cellpadding="0" align="left" class="em_wrapper">
                                        <tr>
                                            <td class="em_grey" align="center" valign="middle"
                                                style="font-family: Arial, sans-serif; font-size: 11px; line-height: 16px; color:#434343;">
                                                &copy; {{company_copyright | Copyright}} &nbsp;
                                                <!--|&nbsp;  <a href="#" target="_blank" style="text-decoration:underline; color:#434343;">Unsubscribe</a>-->
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td height="16" style="font-size:0px; line-height:0px; height:16px;">&nbsp;</td>
                            </tr>
                        </table>
                    </td>
                </tr>
                <tr>
                    <td class="em_hide" style="line-height:1px;min-width:480px;background-color:#F0F2F8;">
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
</body>
</html>
`
const actionLink2Res = `

<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
 "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"
>
<head>
 <title>Teenybase</title>
 <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
 <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
 <meta name="viewport" content="width=device-width, initial-scale=1.0 "/>
 <meta name="format-detection" content="telephone=no"/>
 <style type="text/css">
      body {
          margin: 0;
          padding: 0;
          -webkit-text-size-adjust: 100% !important;
          -ms-text-size-adjust: 100% !important;
          -webkit-font-smoothing: antialiased !important;
          background-color: #F0F2F8;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif;
      }

      img {
          border: 0 !important;
          outline: none !important;
      }

      p {
          Margin: 0px !important;
          Padding: 0px !important;
      }

      table {
          border-collapse: collapse;
          mso-table-lspace: 0px;
          mso-table-rspace: 0px;
      }

      td, a, span {
          border-collapse: collapse;
          mso-line-height-rule: exactly;
      }

      .ExternalClass * {
          line-height: 100%;
      }

      .em_blue a {
          text-decoration: none;
          color: #264780;
      }

      .em_grey a {
          text-decoration: none;
          color: #434343;
      }

      .em_white a {
          text-decoration: none;
          color: #ffffff;
      }

      .em_aside5 {
          padding: 0 20px !important;
      }

      @media only screen and (min-width: 481px) and (max-width: 649px) {
          .em_main_table {
              width: 100% !important;
          }

          .em_wrapper {
              width: 100% !important;
          }

          .em_hide {
              display: none !important;
          }

          .em_aside10 {
              padding: 0px 10px !important;
          }

          .em_h20 {
              height: 20px !important;
              font-size: 1px !important;
              line-height: 1px !important;
          }

          .em_h10 {
              height: 10px !important;
              font-size: 1px !important;
              line-height: 1px !important;
          }

          .em_aside5 {
              padding: 0px 10px !important;
          }
      }

      @media only screen and (min-width: 375px) and (max-width: 480px) {
          .em_main_table {
              width: 100% !important;
          }

          .em_wrapper {
              width: 100% !important;
          }

          .em_hide {
              display: none !important;
          }

          .em_aside10 {
              padding: 0px 10px !important;
          }

          .em_aside5 {
              padding: 0px 8px !important;
          }

          .em_h20 {
              height: 20px !important;
              font-size: 1px !important;
              line-height: 1px !important;
          }

          .em_h10 {
              height: 10px !important;
              font-size: 1px !important;
              line-height: 1px !important;
          }

          .em_font_11 {
              font-size: 12px !important;
          }

          .em_font_22 {
              font-size: 22px !important;
              line-height: 25px !important;
          }

          .em_w5 {
              width: 7px !important;
          }

          u + .em_body .em_full_wrap {
              width: 100% !important;
              width: 100vw !important;
          }
      }

      @media only screen and (max-width: 374px) {
          .em_main_table {
              width: 100% !important;
          }

          .em_wrapper {
              width: 100% !important;
          }

          .em_hide {
              display: none !important;
          }

          .em_aside10 {
              padding: 0px 10px !important;
          }

          .em_aside5 {
              padding: 0px 8px !important;
          }

          .em_h20 {
              height: 20px !important;
              font-size: 1px !important;
              line-height: 1px !important;
          }

          .em_h10 {
              height: 10px !important;
              font-size: 1px !important;
              line-height: 1px !important;
          }

          .em_font_11 {
              font-size: 11px !important;
          }

          .em_font_22 {
              font-size: 22px !important;
              line-height: 25px !important;
          }

          .em_w5 {
              width: 5px !important;
          }

          u + .em_body .em_full_wrap {
              width: 100% !important;
              width: 100vw !important;
          }
      }
 </style>
</head>
<body class="em_body" style="margin:0px auto; padding:0px;" bgcolor="#F0F2F8">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
 <tr>
  <td align="center" valign="top">
   <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
       style="width:480px; min-width:480px; max-width:480px;">
    <tr>
     <td align="left" valign="top" style="padding:0 ;" class="em_aside10">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" align="left">
       <tr>
        <td height="58" style="height:58px;" class="em_h20">&nbsp;</td>
       </tr>
       <tr>
        <td align="left" valign="top">
         <a href="https://teenybase.com" target="_blank" style="text-decoration:none;">
          <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size:20px; line-height:24px; color:rgb(0,0,0); font-weight:500;">Teenybase</span>
         </a>
        </td>
       </tr>
       <tr>
        <td height="32" style="height:32px;" class="em_h20">&nbsp;</td>
       </tr>
      </table>
     </td>
    </tr>
   </table>
  </td>
 </tr>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
 <tr>
  <td align="center" valign="top" class="em_aside5">
   <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
       style="width:480px; min-width:480px; max-width:480px;">
    <tr>
     <td align="center" valign="top"
       style="padding:0 20px; background-color:#ffffff; border-radius:12px;">

      <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
       <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
       </tr>
       <tr>
        <td class="em_blue em_font_22" align="left" valign="top"
          style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 20px; line-height: 28px; color:#303030; font-weight:600;">
         Email Verification
        </td>
       </tr>
       <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
       </tr>
       <tr>
        <td class="em_grey" align="left" valign="top"
          style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 14px; line-height: 20px; color:#4d4d4d;">
         Welcome to Teenybase. Click the button below to verify your email address.
        </td>
       </tr>
       <tr>
        <td align="center" valign="top" style="padding: 20px 0;">

         <a href="https://app.teenybase.com/verify-email/1234567890abcdef" target="_blank" style="text-decoration:none;">
          <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
           <tr>
            <td align="center" valign="middle"
              style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 16px; color:#ffffff; font-weight:500; height:44px; background-color:#0074d4; border-radius:6px;">
             Verify Email
            </td>
           </tr>
          </table>
         </a>
<table width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr><td height="10" style="height:10px; font-size:0px; line-height:0px;">&nbsp;</td></tr>
    <tr>
        <td align="left" style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 12px; line-height: 18px; color: #666666; word-break: break-all;">
            If the button above doesn't work, copy and paste this link into your browser:<br/>
            <a href="https://app.teenybase.com/verify-email/1234567890abcdef" style="color: #0074d4; text-decoration: underline;">https://app.teenybase.com/verify-email/1234567890abcdef</a>
        </td>
    </tr>
</table>

        </td>
       </tr>
       <tr>
        <td class="em_grey" align="left" valign="top"
          style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 14px; line-height: 20px; color:#4d4d4d;">
         If the button does not work, copy and paste the following link into your browser - https://app.teenybase.com/verify-email/1234567890abcdef
        </td>
       </tr>
       <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
       </tr>
      </table>

     </td>
    </tr>
   </table>
  </td>
 </tr>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
 <tr>
  <td align="center" valign="top">
   <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
       style="width:480px; min-width:480px; max-width:480px;">
    <tr>
     <td align="center" valign="top" style="padding:0 20px;" class="em_aside10">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
       <tr>
        <td height="32" style="height:32px;" class="em_h20">&nbsp;</td>
       </tr>
       <tr>
        <td class="em_grey" align="center" valign="top"
          style="font-family: Arial, sans-serif; font-size: 15px; line-height: 18px; color:#434343; font-weight:bold;">
         Problems or questions?
        </td>
       </tr>
       <tr>
        <td height="10" style="height:10px; font-size:1px; line-height:1px;">&nbsp;</td>
       </tr>
       <tr>
        <td align="center" valign="top" style="font-size:0px; line-height:0px;">
         <table border="0" cellspacing="0" cellpadding="0" align="center">
          <tr>
           <td class="em_grey em_font_11" align="left" valign="middle"
             style="font-family: Arial, sans-serif; font-size: 13px; line-height: 15px; color:#434343;">
            <a href="mailto:contact@teenybase.com"
              style="text-decoration:none; color:#434343;">contact@teenybase.com</a>
            <a href="mailto:contact@teenybase.com"
              style="text-decoration:none; color:#434343;">[mailto:contact@teenybase.com]</a>
           </td>
          </tr>
         </table>
        </td>
       </tr>
       <tr>
        <td height="9" style="font-size:0px; line-height:0px; height:9px;" class="em_h10">
        </td>
       </tr>
       <tr>
        <td align="center" valign="top">
         <table border="0" cellspacing="0" cellpadding="0" align="center">
          <tr>
           <td width="12" align="left" valign="middle"
             style="font-size:0px; line-height:0px; width:12px;">
            <!--                                                <a href="#" target="_blank" style="text-decoration:none;"></a>-->
           </td>
           <td width="7" style="width:7px; font-size:0px; line-height:0px;"
             class="em_w5">&nbsp;
           </td>
           <td class="em_grey em_font_11" align="left" valign="middle"
             style="font-family: Arial, sans-serif; font-size: 13px; line-height: 15px; color:#434343;">
            <a href="https://teenybase.com" target="_blank"
              style="text-decoration:none; color:#434343;">Teenybase</a>
            &bull; Teenybase, 123 Teeny St, Tiny Town, TT 12345
           </td>
          </tr>
         </table>
        </td>
       </tr>
       <tr>
        <td height="35" style="height:35px;" class="em_h20">&nbsp;</td>
       </tr>
      </table>
     </td>
    </tr>
    <tr>
     <td height="1" bgcolor="#dadada" style="font-size:0px; line-height:0px; height:1px;">
     </td>
    </tr>
    <tr>
     <td align="center" valign="top" style="padding:0 20px;" class="em_aside10">
      <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
       <tr>
        <td height="16" style="font-size:0px; line-height:0px; height:16px;">&nbsp;</td>
       </tr>
       <tr>
        <td align="center" valign="top">
         <table border="0" cellspacing="0" cellpadding="0" align="left" class="em_wrapper">
          <tr>
           <td class="em_grey" align="center" valign="middle"
             style="font-family: Arial, sans-serif; font-size: 11px; line-height: 16px; color:#434343;">
            &copy; Teenybase, 2024 &nbsp;
            <!--|&nbsp;  <a href="#" target="_blank" style="text-decoration:underline; color:#434343;">Unsubscribe</a>-->
           </td>
          </tr>
         </table>
        </td>
       </tr>
       <tr>
        <td height="16" style="font-size:0px; line-height:0px; height:16px;">&nbsp;</td>
       </tr>
      </table>
     </td>
    </tr>
    <tr>
     <td class="em_hide" style="line-height:1px;min-width:480px;background-color:#F0F2F8;">
     </td>
    </tr>
   </table>
  </td>
 </tr>
</table>
</body>
</html>

`
const actionTextRes = `
<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN"
        "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"
>
<head>
    <title>{{company_name}}</title>
    <meta http-equiv="Content-Type" content="text/html; charset=utf-8"/>
    <meta http-equiv="X-UA-Compatible" content="IE=edge"/>
    <meta name="viewport" content="width=device-width, initial-scale=1.0 "/>
    <meta name="format-detection" content="telephone=no"/>
    <style type="text/css">
        body {
            margin: 0;
            padding: 0;
            -webkit-text-size-adjust: 100% !important;
            -ms-text-size-adjust: 100% !important;
            -webkit-font-smoothing: antialiased !important;
            background-color: #F0F2F8;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif;
        }

        img {
            border: 0 !important;
            outline: none !important;
        }

        p {
            Margin: 0px !important;
            Padding: 0px !important;
        }

        table {
            border-collapse: collapse;
            mso-table-lspace: 0px;
            mso-table-rspace: 0px;
        }

        td, a, span {
            border-collapse: collapse;
            mso-line-height-rule: exactly;
        }

        .ExternalClass * {
            line-height: 100%;
        }

        .em_blue a {
            text-decoration: none;
            color: #264780;
        }

        .em_grey a {
            text-decoration: none;
            color: #434343;
        }

        .em_white a {
            text-decoration: none;
            color: #ffffff;
        }

        .em_aside5 {
            padding: 0 20px !important;
        }

        @media only screen and (min-width: 481px) and (max-width: 649px) {
            .em_main_table {
                width: 100% !important;
            }

            .em_wrapper {
                width: 100% !important;
            }

            .em_hide {
                display: none !important;
            }

            .em_aside10 {
                padding: 0px 10px !important;
            }

            .em_h20 {
                height: 20px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_h10 {
                height: 10px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_aside5 {
                padding: 0px 10px !important;
            }
        }

        @media only screen and (min-width: 375px) and (max-width: 480px) {
            .em_main_table {
                width: 100% !important;
            }

            .em_wrapper {
                width: 100% !important;
            }

            .em_hide {
                display: none !important;
            }

            .em_aside10 {
                padding: 0px 10px !important;
            }

            .em_aside5 {
                padding: 0px 8px !important;
            }

            .em_h20 {
                height: 20px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_h10 {
                height: 10px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_font_11 {
                font-size: 12px !important;
            }

            .em_font_22 {
                font-size: 22px !important;
                line-height: 25px !important;
            }

            .em_w5 {
                width: 7px !important;
            }

            u + .em_body .em_full_wrap {
                width: 100% !important;
                width: 100vw !important;
            }
        }

        @media only screen and (max-width: 374px) {
            .em_main_table {
                width: 100% !important;
            }

            .em_wrapper {
                width: 100% !important;
            }

            .em_hide {
                display: none !important;
            }

            .em_aside10 {
                padding: 0px 10px !important;
            }

            .em_aside5 {
                padding: 0px 8px !important;
            }

            .em_h20 {
                height: 20px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_h10 {
                height: 10px !important;
                font-size: 1px !important;
                line-height: 1px !important;
            }

            .em_font_11 {
                font-size: 11px !important;
            }

            .em_font_22 {
                font-size: 22px !important;
                line-height: 25px !important;
            }

            .em_w5 {
                width: 5px !important;
            }

            u + .em_body .em_full_wrap {
                width: 100% !important;
                width: 100vw !important;
            }
        }
    </style>
</head>
<body class="em_body" style="margin:0px auto; padding:0px;" bgcolor="#F0F2F8">
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
    <tr>
        <td align="center" valign="top">
            <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
                   style="width:480px; min-width:480px; max-width:480px;">
                <tr>
                    <td align="left" valign="top" style="padding:0 ;" class="em_aside10">
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" align="left">
                            <tr>
                                <td height="58" style="height:58px;" class="em_h20">&nbsp;</td>
                            </tr>
                            <tr>
                                <td align="left" valign="top">
                                    <a href="{{company_url}}" target="_blank" style="text-decoration:none;">
                                        <span style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size:20px; line-height:24px; color:rgb(0,0,0); font-weight:500;">{{company_name}}</span>
                                    </a>
                                </td>
                            </tr>
                            <tr>
                                <td height="32" style="height:32px;" class="em_h20">&nbsp;</td>
                            </tr>
                        </table>
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
    <tr>
        <td align="center" valign="top" class="em_aside5">
            <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
                   style="width:480px; min-width:480px; max-width:480px;">
                <tr>
                    <td align="center" valign="top"
                        style="padding:0 20px; background-color:#ffffff; border-radius:12px;">

<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
    <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
    </tr>
    <tr>
        <td class="em_blue em_font_22" align="left" valign="top"
            style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 20px; line-height: 28px; color:#303030; font-weight:600;">
            {{message_title}}
        </td>
    </tr>
    <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
    </tr>
    <tr>
        <td class="em_grey" align="left" valign="top"
            style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 14px; line-height: 20px; color:#4d4d4d;">
            {{message_description}}
        </td>
    </tr>
    <tr>
        <td align="center" valign="top" style="padding: 20px 0;">

<table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
    <tr>
        <td align="center" valign="middle"
            style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 16px; color:{{action_text_color | #ffffff}}; font-weight:500; height:44px; background-color:{{action_button_color | #0074d4}}; border-radius:6px;">
            {{action_text}}
        </td>
    </tr>
</table>

        </td>
    </tr>
    <tr>
        <td class="em_grey" align="left" valign="top"
            style="font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Ubuntu, sans-serif; font-size: 14px; line-height: 20px; color:#4d4d4d;">
            {{message_footer}}
        </td>
    </tr>
    <tr>
        <td height="16" style="height:16px; font-size:0px; line-height:0px;">&nbsp;</td>
    </tr>
</table>

                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
<table width="100%" border="0" cellspacing="0" cellpadding="0" class="em_full_wrap" align="center" bgcolor="#F0F2F8">
    <tr>
        <td align="center" valign="top">
            <table align="center" width="480" border="0" cellspacing="0" cellpadding="0" class="em_main_table"
                   style="width:480px; min-width:480px; max-width:480px;">
                <tr>
                    <td align="center" valign="top" style="padding:0 20px;" class="em_aside10">
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
                            <tr>
                                <td height="32" style="height:32px;" class="em_h20">&nbsp;</td>
                            </tr>
                            <tr>
                                <td class="em_grey" align="center" valign="top"
                                    style="font-family: Arial, sans-serif; font-size: 15px; line-height: 18px; color:#434343; font-weight:bold;">
                                    Problems or questions?
                                </td>
                            </tr>
                            <tr>
                                <td height="10" style="height:10px; font-size:1px; line-height:1px;">&nbsp;</td>
                            </tr>
                            <tr>
                                <td align="center" valign="top" style="font-size:0px; line-height:0px;">
                                    <table border="0" cellspacing="0" cellpadding="0" align="center">
                                        <tr>
                                            <td class="em_grey em_font_11" align="left" valign="middle"
                                                style="font-family: Arial, sans-serif; font-size: 13px; line-height: 15px; color:#434343;">
                                                <a href="mailto:{{support_email}}"
                                                   style="text-decoration:none; color:#434343;">{{support_email}}</a>
                                                <a href="mailto:{{support_email}}"
                                                   style="text-decoration:none; color:#434343;">[mailto:{{support_email}}]</a>
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td height="9" style="font-size:0px; line-height:0px; height:9px;" class="em_h10">
                                </td>
                            </tr>
                            <tr>
                                <td align="center" valign="top">
                                    <table border="0" cellspacing="0" cellpadding="0" align="center">
                                        <tr>
                                            <td width="12" align="left" valign="middle"
                                                style="font-size:0px; line-height:0px; width:12px;">
                                                <!--                                                <a href="#" target="_blank" style="text-decoration:none;"></a>-->
                                            </td>
                                            <td width="7" style="width:7px; font-size:0px; line-height:0px;"
                                                class="em_w5">&nbsp;
                                            </td>
                                            <td class="em_grey em_font_11" align="left" valign="middle"
                                                style="font-family: Arial, sans-serif; font-size: 13px; line-height: 15px; color:#434343;">
                                                <a href="{{company_url}}" target="_blank"
                                                   style="text-decoration:none; color:#434343;">{{company_name}}</a>
                                                &bull; {{company_address}}
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td height="35" style="height:35px;" class="em_h20">&nbsp;</td>
                            </tr>
                        </table>
                    </td>
                </tr>
                <tr>
                    <td height="1" bgcolor="#dadada" style="font-size:0px; line-height:0px; height:1px;">
                    </td>
                </tr>
                <tr>
                    <td align="center" valign="top" style="padding:0 20px;" class="em_aside10">
                        <table width="100%" border="0" cellspacing="0" cellpadding="0" align="center">
                            <tr>
                                <td height="16" style="font-size:0px; line-height:0px; height:16px;">&nbsp;</td>
                            </tr>
                            <tr>
                                <td align="center" valign="top">
                                    <table border="0" cellspacing="0" cellpadding="0" align="left" class="em_wrapper">
                                        <tr>
                                            <td class="em_grey" align="center" valign="middle"
                                                style="font-family: Arial, sans-serif; font-size: 11px; line-height: 16px; color:#434343;">
                                                &copy; {{company_copyright | Copyright}} &nbsp;
                                                <!--|&nbsp;  <a href="#" target="_blank" style="text-decoration:underline; color:#434343;">Unsubscribe</a>-->
                                            </td>
                                        </tr>
                                    </table>
                                </td>
                            </tr>
                            <tr>
                                <td height="16" style="font-size:0px; line-height:0px; height:16px;">&nbsp;</td>
                            </tr>
                        </table>
                    </td>
                </tr>
                <tr>
                    <td class="em_hide" style="line-height:1px;min-width:480px;background-color:#F0F2F8;">
                    </td>
                </tr>
            </table>
        </td>
    </tr>
</table>
</body>
</html>
`
