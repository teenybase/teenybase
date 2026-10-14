export const actionLinkTemplate = `
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
`
